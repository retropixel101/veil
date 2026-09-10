"use strict";

const ROOT = new URL("./", document.baseURI).href;
const PREFIX = new URL("service/", ROOT).pathname;
const WISP = "wss://wisp-backend-weyl.onrender.com";

const VEIL_CONFIG = {
    prefix: PREFIX,

    files: {
        all: new URL("sj/scramjet.all.js", ROOT).href,
        sync: new URL("sj/scramjet.sync.js", ROOT).href,
        wasm: new URL("sj/scramjet.wasm.wasm", ROOT).href
    },

    baremux: new URL("bm/worker.js", ROOT).href,
    baremuxModule: new URL("bm/index.mjs", ROOT).href,
    epoxy: new URL("ep/index.mjs", ROOT).href,

    wisp: WISP
};

window.__veil = window.__veil || {};
window.__veil.config = VEIL_CONFIG;
window.__scramjet$config = VEIL_CONFIG;

let veilController = null;
let veilConnection = null;
let veilReady = false;
let veilInitPromise = null;

let adBlock =
    localStorage.getItem("veil-adblock") === "true";


function loadScript(src) {
    return new Promise((resolve, reject) => {
        const existing = [...document.scripts].find(
            script => script.src === src
        );

        if (existing) {
            if (existing.dataset.loaded === "true") {
                resolve();
                return;
            }

            existing.addEventListener(
                "load",
                resolve,
                { once: true }
            );

            existing.addEventListener(
                "error",
                () => reject(
                    new Error("Failed to load " + src)
                ),
                { once: true }
            );

            return;
        }

        const script = document.createElement("script");

        script.src = src;
        script.async = false;

        script.onload = () => {
            script.dataset.loaded = "true";
            resolve();
        };

        script.onerror = () => {
            reject(
                new Error("Failed to load " + src)
            );
        };

        document.head.appendChild(script);
    });
}


async function resetScramjetDatabases() {
    if (!("indexedDB" in window)) {
        return;
    }

    try {
        if (typeof indexedDB.databases === "function") {
            const databases =
                await indexedDB.databases();

            const names = databases
                .map(db => db.name)
                .filter(
                    name =>
                        name &&
                        /scramjet/i.test(name)
                );

            await Promise.all(
                names.map(name =>
                    new Promise(resolve => {
                        const request =
                            indexedDB.deleteDatabase(name);

                        request.onsuccess =
                        request.onerror =
                        request.onblocked =
                            () => resolve();
                    })
                )
            );

            return;
        }
    } catch (error) {
        console.warn(
            "Veil: automatic Scramjet database discovery failed.",
            error
        );
    }

    for (const name of [
        "scramjet-data",
        "scramjet",
        "ScramjetData",
        "scrambase"
    ]) {
        try {
            indexedDB.deleteDatabase(name);
        } catch {}
    }
}


async function sendServiceWorkerConfig() {
    const message = {
        type: "veil-config",
        wisp: WISP,
        adBlock
    };

    const registration =
        await navigator.serviceWorker.getRegistration(
            PREFIX
        );

    const worker =
        registration?.active ||
        navigator.serviceWorker.controller;

    if (worker) {
        worker.postMessage(message);
    }
}


async function initBareMux() {
    if (veilConnection) {
        return veilConnection;
    }

    const BareMux =
        await import(VEIL_CONFIG.baremuxModule);

    const BareMuxConnection =
        BareMux.BareMuxConnection;

    if (
        typeof BareMuxConnection !==
        "function"
    ) {
        throw new Error(
            "BareMuxConnection was not found in local BareMux."
        );
    }

    veilConnection =
        new BareMuxConnection(
            VEIL_CONFIG.baremux
        );

    await veilConnection.setTransport(
        VEIL_CONFIG.epoxy,
        [
            {
                wisp: WISP
            }
        ]
    );

    return veilConnection;
}


async function initVeilEngine() {
    if (veilInitPromise) {
        return veilInitPromise;
    }

    veilInitPromise = (async () => {

        if (!("serviceWorker" in navigator)) {
            throw new Error(
                "Service workers are not supported."
            );
        }

        await loadScript(
            VEIL_CONFIG.files.all
        );

        const registration =
            await navigator.serviceWorker.register(
                new URL("sw.js", ROOT).href,
                {
                    scope: PREFIX
                }
            );

        await navigator.serviceWorker.ready;

        await initBareMux();

        await sendServiceWorkerConfig();

        if (
            typeof window.$scramjetLoadController !==
            "function"
        ) {
            throw new Error(
                "Scramjet 1.x controller loader was not found."
            );
        }

        const loaded =
            window.$scramjetLoadController();

        const ScramjetController =
            loaded?.ScramjetController;

        if (
            typeof ScramjetController !==
            "function"
        ) {
            throw new Error(
                "ScramjetController was not found in scramjet.all.js."
            );
        }

        veilController =
            new ScramjetController({
                files: VEIL_CONFIG.files,
                prefix: VEIL_CONFIG.prefix
            });

        try {

            if (
                typeof veilController.init ===
                "function"
            ) {
                await veilController.init();
            }

        } catch (error) {

            const message =
                String(
                    error?.message ||
                    error
                );

           if (/IDBDatabase|object stores|NotFoundError/i.test(message)) {
    console.warn(
        "Veil: stale Scramjet IndexedDB schema detected; resetting databases."
    );

    await resetScramjetDatabases();

    veilController = new ScramjetController({
        files: VEIL_CONFIG.files,
        prefix: VEIL_CONFIG.prefix
    });

    if (typeof veilController.init === "function") {
        await veilController.init();
    }
} else {
    throw error;
}
        }

        veilReady = true;

        window.dispatchEvent(
            new CustomEvent(
                "veilengine-ready",
                {
                    detail: {
                        registration,
                        controller:
                            veilController,

                        connection:
                            veilConnection
                    }
                }
            )
        );

        return veilController;

    })().catch(error => {

        veilInitPromise = null;
        veilReady = false;

        throw error;
    });

    return veilInitPromise;
}


async function createVeilFrame(
    container,
    url
) {
    const controller =
        await initVeilEngine();

    if (
        !controller ||
        typeof controller.createFrame !==
        "function"
    ) {
        throw new Error(
            "Scramjet frame API is unavailable."
        );
    }

    const frameObject =
        controller.createFrame();

    const frame =
        frameObject?.frame;

    if (
        !(frame instanceof HTMLIFrameElement)
    ) {
        throw new Error(
            "Scramjet returned an invalid frame."
        );
    }

    frame.style.width = "100%";
    frame.style.height = "100%";
    frame.style.display = "block";
    frame.style.border = "0";

    container.replaceChildren(frame);

    if (
        typeof frameObject.go !==
        "function"
    ) {
        throw new Error(
            "Scramjet frame navigation API is unavailable."
        );
    }

    await frameObject.go(url);

    return frameObject;
}


async function navigateVeil(url) {
    if (!url) {
        return;
    }

    const value =
        String(url).trim();

    if (!value) {
        return;
    }

    let target;

    try {
        target = new URL(value);
    } catch {
        target = new URL(
            "https://www.google.com/search?q=" +
            encodeURIComponent(value)
        );
    }

    if (
        !/^https?:$/.test(
            target.protocol
        )
    ) {
        throw new Error(
            "Only HTTP and HTTPS addresses are supported."
        );
    }

    return target.href;
}


async function setAdBlock(enabled) {
    adBlock = Boolean(enabled);

    if (adBlock) {
        localStorage.setItem(
            "veil-adblock",
            "true"
        );
    } else {
        localStorage.removeItem(
            "veil-adblock"
        );
    }

    try {
        await sendServiceWorkerConfig();
    } catch (error) {
        console.warn(
            "Veil: could not update ad-block state in the service worker.",
            error
        );
    }

    window.dispatchEvent(
        new CustomEvent(
            "veil-adblock-change",
            {
                detail: {
                    enabled: adBlock
                }
            }
        )
    );

    return adBlock;
}


window.VeilEngine = {

    config: VEIL_CONFIG,

    init:
        initVeilEngine,

    createFrame:
        createVeilFrame,

    navigate:
        navigateVeil,

    setAdBlock:

        setAdBlock,

    get adBlock() {
        return adBlock;
    },

    get ready() {
        return veilReady;
    },

    get controller() {
        return veilController;
    },

    get connection() {
        return veilConnection;
    }
};


initVeilEngine()
    .catch(error => {

        console.error(
            "Veil engine initialization failed:",
            error
        );

        window.dispatchEvent(
            new CustomEvent(
                "veilengine-error",
                {
                    detail: error
                }
            )
        );
    });