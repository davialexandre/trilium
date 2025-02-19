import server from "./server.js";
import renderService from "./render.js";
import protectedSessionService from "./protected_session.js";
import protectedSessionHolder from "./protected_session_holder.js";
import libraryLoader from "./library_loader.js";
import openService from "./open.js";
import treeCache from "./tree_cache.js";

async function getRenderedContent(note, options = {}) {
    options = Object.assign({
        trim: false,
        tooltip: false
    }, options);

    const type = getRenderingType(note);

    const $renderedContent = $('<div class="rendered-note-content">');

    if (type === 'text') {
        const noteComplement = await treeCache.getNoteComplement(note.noteId);

        $renderedContent.append($('<div class="ck-content">').html(trim(noteComplement.content, options.trim)));

        if ($renderedContent.find('span.math-tex').length > 0) {
            await libraryLoader.requireLibrary(libraryLoader.KATEX);

            renderMathInElement($renderedContent[0], {});
        }
    }
    else if (type === 'code') {
        const fullNote = await server.get('notes/' + note.noteId);

        $renderedContent.append($("<pre>").text(trim(fullNote.content, options.trim)));
    }
    else if (type === 'image') {
        $renderedContent.append(
            $("<img>")
                .attr("src", `api/images/${note.noteId}/${note.title}`)
                .css("max-width", "100%")
        );
    }
    else if (!options.tooltip && (type === 'file' || type === 'pdf')) {
        const $downloadButton = $('<button class="file-download btn btn-primary" type="button">Download</button>');
        const $openButton = $('<button class="file-open btn btn-primary" type="button">Open</button>');

        $downloadButton.on('click', () => openService.downloadFileNote(note.noteId));
        $openButton.on('click', () => openService.openFileNote(note.noteId));

        // open doesn't work for protected notes since it works through browser which isn't in protected session
        $openButton.toggle(!note.isProtected);

        const $content = $('<div style="display: flex; flex-direction: column; height: 100%;">');

        if (type === 'pdf') {
            const $pdfPreview = $('<iframe class="pdf-preview" style="width: 100%; flex-grow: 100;"></iframe>');
            $pdfPreview.attr("src", openService.getUrlForDownload("api/notes/" + note.noteId + "/open"));

            $content.append($pdfPreview);
        }

        $content.append(
            $('<div style="display: flex; justify-content: space-evenly; margin-top: 5px;">')
                .append($downloadButton)
                .append($openButton)
        );

        $renderedContent.append($content);
    }
    else if (type === 'render') {
        const $content = $('<div>');

        await renderService.render(note, $content, this.ctx);

        $renderedContent.append($content);
    }
    else if (!options.tooltip && type === 'protected-session') {
        const $button = $(`<button class="btn btn-sm"><span class="bx bx-log-in"></span> Enter protected session</button>`)
            .on('click', protectedSessionService.enterProtectedSession);

        $renderedContent.append(
            $("<div>")
                .append("<div>This note is protected and to access it you need to enter password.</div>")
                .append("<br/>")
                .append($button)
        );
    }
    else {
        $renderedContent.append($("<p><em>Content of this note cannot be displayed in the book format</em></p>"));
    }

    $renderedContent.addClass(note.getCssClass());

    return {
        $renderedContent,
        type
    };
}

function trim(text, doTrim) {
    if (!doTrim) {
        return text;
    }
    else {
        return text.substr(0, Math.min(text.length, 1000));
    }
}

function getRenderingType(note) {
    let type = note.type;

    if (type === 'file' && note.mime === 'application/pdf') {
        type = 'pdf';
    }

    if (note.isProtected) {
        if (protectedSessionHolder.isProtectedSessionAvailable()) {
            protectedSessionHolder.touchProtectedSession();
        }
        else {
            type = 'protected-session';
        }
    }

    return type;
}

export default {
    getRenderedContent
};
