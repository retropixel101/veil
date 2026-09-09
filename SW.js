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
let scramjetReady = null;

try {
    importScripts(SCRAMJET_ALL);

    if (typeof $scramjetLoadWorker !== "function") {
        throw new Error(
            "S/SA.js loaded, but $scramjetLoadWorker() was not found."
        );
    }

    const workerAPI = $scramjetLoadWorker();

    if (
        !workerAPI ||
        typeof workerAPI.ScramjetServiceWorker !== "function"
    ) {
        throw new Error(
            "S/SA.js loaded, but ScramjetServiceWorker was not exposed by $scramjetLoadWorker()."
        );
    }

    const ScramjetServiceWorker =
        workerAPI.ScramjetServiceWorker;

    scramjet = new ScramjetServiceWorker();

    scramjetReady = Promise.resolve(
        typeof scramjet.loadConfig === "function"
            ? scramjet.loadConfig()
            : undefined
    );

    console.log(
        "Veil: Scramjet service worker initialized."
    );

} catch (error) {

    console.error(
        "Veil: Scramjet service worker initialization failed.",
        error
    );

    scramjet = null;

    scramjetReady = Promise.reject(error);

    scramjetReady.catch(() => {});
}

self.addEventListener("install", event => {
    console.log("Veil: service worker installed.");
    self.skipWaiting();
});

self.addEventListener("activate", event => {
    event.waitUntil(
        self.clients.claim()
    );
});

self.addEventListener("fetch", event => {

    if (!scramjet) {
        return;
    }

    const requestURL = new URL(
        event.request.url
    );

    if (
        requestURL.origin !== self.location.origin ||
        !requestURL.pathname.startsWith(PREFIX)
    ) {
        return;
    }

    event.respondWith(
        (async () => {

            try {

                await scramjetReady;

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
                    "Veil could not proxy this request.\n\n" +
                    "Scramjet error: " +
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