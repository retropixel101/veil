"use strict";

const ROOT = new URL("./", self.location.href);

const PREFIX = new URL(
    "service/",
    ROOT
).pathname;

const SCRAMJET_ALL = new URL(
    "S/SA.js",
    ROOT
).href;

const SCRAMJET_SYNC = new URL(
    "S/SS.js",
    ROOT
).href;

const SCRAMJET_WASM = new URL(
    "S/SW.wasm",
    ROOT
).href;

self.__scramjet$config = {
    prefix: PREFIX,

    files: {
        all: SCRAMJET_ALL,
        sync: SCRAMJET_SYNC,
        wasm: SCRAMJET_WASM
    }
};

let scramjet = null;
let initError = null;

try {
    importScripts(SCRAMJET_ALL);

    if (typeof $scramjetLoadWorker !== "function") {
        throw new Error(
            "S/SA.js loaded, but $scramjetLoadWorker() is not available. " +
            "The Scramjet bundle and SW.js are incompatible."
        );
    }

    const worker = $scramjetLoadWorker();

    if (
        !worker ||
        typeof worker.ScramjetServiceWorker !== "function"
    ) {
        throw new Error(
            "$scramjetLoadWorker() ran, but ScramjetServiceWorker " +
            "was not returned."
        );
    }

    scramjet = new worker.ScramjetServiceWorker();

    console.log(
        "Veil: ScramjetServiceWorker initialized."
    );

} catch (error) {

    initError = error;

    console.error(
        "Veil: Scramjet service worker failed to initialize.",
        error
    );
}

self.addEventListener("install", event => {
    console.log("Veil: SW installed.");
    event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", event => {
    console.log("Veil: SW activated.");
    event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", event => {

    if (!scramjet) {
        if (initError) {
            console.error(
                "Veil: proxy unavailable:",
                initError
            );
        }

        return;
    }

    const url = new URL(
        event.request.url
    );

    if (url.origin !== self.location.origin) {
        return;
    }

    if (!url.pathname.startsWith(PREFIX)) {
        return;
    }

    event.respondWith(
        (async () => {

            try {

                if (
                    typeof scramjet.loadConfig === "function"
                ) {
                    await scramjet.loadConfig();
                }

                if (
                    typeof scramjet.route === "function" &&
                    !scramjet.route(event)
                ) {
                    return fetch(event.request);
                }

                return await scramjet.fetch(event);

            } catch (error) {

                console.error(
                    "Veil: Scramjet fetch failed.",
                    error
                );

                return new Response(
                    "Veil Scramjet error: " +
                    (error?.message || String(error)),
                    {
                        status: 502,
                        headers: {
                            "Content-Type":
                                "text/plain; charset=utf-8"
                        }
                    }
                );
            }

        })()
    );
});