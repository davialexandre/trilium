"use strict";

const log = require('./log');
const sql = require('./sql');
const sqlInit = require('./sql_init');
const optionService = require('./options');
const utils = require('./utils');
const sourceIdService = require('./source_id');
const dateUtils = require('./date_utils');
const syncUpdateService = require('./sync_update');
const contentHashService = require('./content_hash');
const appInfo = require('./app_info');
const syncOptions = require('./sync_options');
const syncMutexService = require('./sync_mutex');
const cls = require('./cls');
const request = require('./request');
const ws = require('./ws');
const entityChangesService = require('./entity_changes.js');
const entityConstructor = require('../entities/entity_constructor');

let proxyToggle = true;

let outstandingPullCount = 0;

async function sync() {
    try {
        return await syncMutexService.doExclusively(async () => {
            if (!syncOptions.isSyncSetup()) {
                return { success: false, message: 'Sync not configured' };
            }

            let continueSync = false;

            do {
                const syncContext = await login();

                await pushChanges(syncContext);

                await pullChanges(syncContext);

                await pushChanges(syncContext);

                await syncFinished(syncContext);

                continueSync = await checkContentHash(syncContext);
            }
            while (continueSync);

            ws.syncFinished();

            return {
                success: true
            };
        });
    }
    catch (e) {
        proxyToggle = !proxyToggle;

        if (e.message &&
                (e.message.includes('ECONNREFUSED') ||
                 e.message.includes('ERR_CONNECTION_REFUSED') ||
                 e.message.includes('Bad Gateway'))) {

            ws.syncFailed();

            log.info("No connection to sync server.");

            return {
                success: false,
                message: "No connection to sync server."
            };
        }
        else {
            log.info("sync failed: " + e.message + "\nstack: " + e.stack);

            ws.syncFailed();

            return {
                success: false,
                message: e.message
            }
        }
    }
}

async function login() {
    const setupService = require('./setup'); // circular dependency issue

    if (!await setupService.hasSyncServerSchemaAndSeed()) {
        await setupService.sendSeedToSyncServer();
    }

    return await doLogin();
}

async function doLogin() {
    const timestamp = dateUtils.utcNowDateTime();

    const documentSecret = optionService.getOption('documentSecret');
    const hash = utils.hmac(documentSecret, timestamp);

    const syncContext = { cookieJar: {} };
    const resp = await syncRequest(syncContext, 'POST', '/api/login/sync', {
        timestamp: timestamp,
        syncVersion: appInfo.syncVersion,
        hash: hash
    });

    if (sourceIdService.isLocalSourceId(resp.sourceId)) {
        throw new Error(`Sync server has source ID ${resp.sourceId} which is also local. This usually happens when the sync client is (mis)configured to sync with itself (URL points back to client) instead of the correct sync server.`);
    }

    syncContext.sourceId = resp.sourceId;

    const lastSyncedPull = getLastSyncedPull();

    // this is important in a scenario where we setup the sync by manually copying the document
    // lastSyncedPull then could be pretty off for the newly cloned client
    if (lastSyncedPull > resp.maxEntityChangeId) {
        log.info(`Lowering last synced pull from ${lastSyncedPull} to ${resp.maxEntityChangeId}`);

        setLastSyncedPull(resp.maxEntityChangeId);
    }

    return syncContext;
}

async function pullChanges(syncContext) {
    let atLeastOnePullApplied = false;

    while (true) {
        const lastSyncedPull = getLastSyncedPull();
        const changesUri = '/api/sync/changed?lastEntityChangeId=' + lastSyncedPull;

        const startDate = Date.now();

        const resp = await syncRequest(syncContext, 'GET', changesUri);

        const pulledDate = Date.now();

        outstandingPullCount = Math.max(0, resp.maxEntityChangeId - lastSyncedPull);

        const {entityChanges} = resp;

        if (entityChanges.length === 0) {
            break;
        }

        sql.transactional(() => {
            for (const {entityChange, entity} of entityChanges) {
                if (!sourceIdService.isLocalSourceId(entityChange.sourceId)) {
                    if (!atLeastOnePullApplied) { // send only for first
                        ws.syncPullInProgress();

                        atLeastOnePullApplied = true;
                    }

                    syncUpdateService.updateEntity(entityChange, entity, syncContext.sourceId);
                }

                outstandingPullCount = Math.max(0, resp.maxEntityChangeId - entityChange.id);
            }

            setLastSyncedPull(entityChanges[entityChanges.length - 1].entityChange.id);
        });

        const sizeInKb = Math.round(JSON.stringify(resp).length / 1024);

        log.info(`Pulled ${entityChanges.length} changes in ${sizeInKb} KB, starting at entityChangeId=${lastSyncedPull} in ${pulledDate - startDate}ms and applied them in ${Date.now() - pulledDate}ms, ${outstandingPullCount} outstanding pulls`);
    }

    log.info("Finished pull");
}

async function pushChanges(syncContext) {
    let lastSyncedPush = getLastSyncedPush();

    while (true) {
        const entityChanges = sql.getRows('SELECT * FROM entity_changes WHERE isSynced = 1 AND id > ? LIMIT 1000', [lastSyncedPush]);

        if (entityChanges.length === 0) {
            log.info("Nothing to push");

            break;
        }

        const filteredEntityChanges = entityChanges.filter(entityChange => {
            if (entityChange.sourceId === syncContext.sourceId) {
                // this may set lastSyncedPush beyond what's actually sent (because of size limit)
                // so this is applied to the database only if there's no actual update
                // TODO: it would be better to simplify this somehow
                lastSyncedPush = entityChange.id;

                return false;
            }
            else {
                return true;
            }
        });

        if (filteredEntityChanges.length === 0) {
            // there still might be more sync changes (because of batch limit), just all from current batch
            // has been filtered out
            setLastSyncedPush(lastSyncedPush);

            continue;
        }

        const entityChangesRecords = getEntityChangesRecords(filteredEntityChanges);
        const startDate = new Date();

        await syncRequest(syncContext, 'PUT', '/api/sync/update', {
            sourceId: sourceIdService.getCurrentSourceId(),
            entities: entityChangesRecords
        });

        ws.syncPushInProgress();

        log.info(`Pushing ${entityChangesRecords.length} sync changes in ` + (Date.now() - startDate.getTime()) + "ms");

        lastSyncedPush = entityChangesRecords[entityChangesRecords.length - 1].entityChange.id;

        setLastSyncedPush(lastSyncedPush);
    }
}

async function syncFinished(syncContext) {
    await syncRequest(syncContext, 'POST', '/api/sync/finished');
}

async function checkContentHash(syncContext) {
    const resp = await syncRequest(syncContext, 'GET', '/api/sync/check');
    const lastSyncedPullId = getLastSyncedPull();

    if (lastSyncedPullId < resp.maxEntityChangeId) {
        log.info(`There are some outstanding pulls (${lastSyncedPullId} vs. ${resp.maxEntityChangeId}), skipping content check.`);

        return true;
    }

    const notPushedSyncs = sql.getValue("SELECT EXISTS(SELECT 1 FROM entity_changes WHERE isSynced = 1 AND id > ?)", [getLastSyncedPush()]);

    if (notPushedSyncs) {
        log.info(`There's ${notPushedSyncs} outstanding pushes, skipping content check.`);

        return true;
    }

    const failedChecks = contentHashService.checkContentHashes(resp.entityHashes);

    for (const {entityName, sector} of failedChecks) {
        entityChangesService.addEntityChangesForSector(entityName, sector);

        await syncRequest(syncContext, 'POST', `/api/sync/queue-sector/${entityName}/${sector}`);
    }

    return failedChecks.length > 0;
}

const PAGE_SIZE = 1000000;

async function syncRequest(syncContext, method, requestPath, body) {
    body = body ? JSON.stringify(body) : '';

    const timeout = syncOptions.getSyncTimeout();

    let response;

    const requestId = utils.randomString(10);
    const pageCount = Math.max(1, Math.ceil(body.length / PAGE_SIZE));

    for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
        const opts = {
            method,
            url: syncOptions.getSyncServerHost() + requestPath,
            cookieJar: syncContext.cookieJar,
            timeout: timeout,
            paging: {
                pageIndex,
                pageCount,
                requestId
            },
            body: body.substr(pageIndex * PAGE_SIZE, Math.min(PAGE_SIZE, body.length - pageIndex * PAGE_SIZE)),
            proxy: proxyToggle ? syncOptions.getSyncProxy() : null
        };

        response = await utils.timeLimit(request.exec(opts), timeout);
    }

    return response;
}

function getEntityChangeRow(entityName, entityId) {
    if (entityName === 'note_reordering') {
        return sql.getMap("SELECT branchId, notePosition FROM branches WHERE parentNoteId = ? AND isDeleted = 0", [entityId]);
    }
    else {
        const primaryKey = entityConstructor.getEntityFromEntityName(entityName).primaryKeyName;

        if (!primaryKey) {
            throw new Error("Unknown entity " + entityName);
        }

        const entity = sql.getRow(`SELECT * FROM ${entityName} WHERE ${primaryKey} = ?`, [entityId]);

        if (!entity) {
            throw new Error(`Entity ${entityName} ${entityId} not found.`);
        }

        if (['note_contents', 'note_revision_contents'].includes(entityName) && entity.content !== null) {
            if (typeof entity.content === 'string') {
                entity.content = Buffer.from(entity.content, 'UTF-8');
            }

            entity.content = entity.content.toString("base64");
        }

        return entity;
    }
}

function getEntityChangesRecords(entityChanges) {
    const records = [];
    let length = 0;

    for (const entityChange of entityChanges) {
        if (entityChange.isErased) {
            records.push({entityChange});

            continue;
        }

        const entity = getEntityChangeRow(entityChange.entityName, entityChange.entityId);

        if (entityChange.entityName === 'options' && !entity.isSynced) {
            records.push({entityChange});

            continue;
        }

        const record = { entityChange, entity };

        records.push(record);

        length += JSON.stringify(record).length;

        if (length > 1000000) {
            break;
        }
    }

    return records;
}

function getLastSyncedPull() {
    return parseInt(optionService.getOption('lastSyncedPull'));
}

function setLastSyncedPull(entityChangeId) {
    optionService.setOption('lastSyncedPull', entityChangeId);
}

function getLastSyncedPush() {
    const lastSyncedPush = parseInt(optionService.getOption('lastSyncedPush'));

    ws.setLastSyncedPush(lastSyncedPush);

    return lastSyncedPush;
}

function setLastSyncedPush(entityChangeId) {
    ws.setLastSyncedPush(entityChangeId);

    optionService.setOption('lastSyncedPush', entityChangeId);
}

function getMaxEntityChangeId() {
    return sql.getValue('SELECT COALESCE(MAX(id), 0) FROM entity_changes');
}

function getOutstandingPullCount() {
    return outstandingPullCount;
}

sqlInit.dbReady.then(() => {
    setInterval(cls.wrap(sync), 60000);

    // kickoff initial sync immediately
    setTimeout(cls.wrap(sync), 5000);
});

if (sqlInit.isDbInitialized()) {
    // called just so ws.setLastSyncedPush() is called
    getLastSyncedPush();
}

module.exports = {
    sync,
    login,
    getEntityChangesRecords,
    getOutstandingPullCount,
    getMaxEntityChangeId
};
