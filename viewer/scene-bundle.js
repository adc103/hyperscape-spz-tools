'use strict';

let sceneBundlePromise;

function loadSceneBundle() {
    if (!sceneBundlePromise) {
        sceneBundlePromise = (async () => {
            const response = await fetch(new URL('scene-bundle.js.gz', document.baseURI));
            if (!response.ok) throw Error('Could not load the export ZIP reader.');
            const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
            const code = await new Response(stream).blob();
            const url = URL.createObjectURL(new Blob([code], {type:'text/javascript'}));
            try {
                await new Promise((resolve, reject) => {
                    const script = document.createElement('script');
                    script.src = url;
                    script.onload = resolve;
                    script.onerror = () => reject(Error('Could not load the export ZIP reader.'));
                    document.head.append(script);
                });
                if (!globalThis.HyperscapeBundle) throw Error('The export ZIP reader did not initialize.');
                return globalThis.HyperscapeBundle;
            } finally {
                URL.revokeObjectURL(url);
            }
        })().catch(error => {
            sceneBundlePromise = undefined;
            throw error;
        });
    }
    return sceneBundlePromise;
}
