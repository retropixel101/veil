"use strict";

const ROOT = new URL("./", document.baseURI).href;

const VEIL_CONFIG = {
prefix: new URL("service/", ROOT).pathname,
files: {
all: new URL("S/SA.js", ROOT).href,
sync: new URL("S/SS.js", ROOT).href,
wasm: new URL("S/SW.wasm", ROOT).href
},
wisp: "wss://wisp-backend-weyl.onrender.com"
};

window.__veil = window.__veil || {};
window.__veil.config = VEIL_CONFIG;
window.__scramjet$config = VEIL_CONFIG;

let veilController = null;
let veilReady = false;
let veilInitPromise = null;

function loadScript(src) {
return new Promise((resolve, reject) => {
const existing = [...document.scripts].find(s => s.src === src);

    if (existing) {
        if (existing.dataset.loaded === "true") {
            resolve();
            return;
        }

        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener(
            "error",
            () => reject(new Error("Failed to load " + src)),
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
        reject(new Error("Failed to load " + src));
    };

    document.head.appendChild(script);
});

}

async function initVeilEngine() {
if (veilInitPromise) return veilInitPromise;

veilInitPromise = (async () => {
    if (!("serviceWorker" in navigator)) {
        throw new Error("Service workers are not supported.");
    }

    await loadScript(VEIL_CONFIG.files.all);

    const registration = await navigator.serviceWorker.register(
        new URL("SW.js", ROOT).href,
        {
            scope: VEIL_CONFIG.prefix
        }
    );

    await navigator.serviceWorker.ready;

    if (typeof window.$scramjetLoadController === "function") {
        const result = window.$scramjetLoadController();

        if (result && result.ScramjetController) {
            veilController = new result.ScramjetController({
                files: VEIL_CONFIG.files,
                prefix: VEIL_CONFIG.prefix
            });
        }
    }

    if (!veilController && typeof window.ScramjetController === "function") {
        veilController = new window.ScramjetController({
            files: VEIL_CONFIG.files,
            prefix: VEIL_CONFIG.prefix
        });
    }

    if (!veilController) {
        throw new Error(
            "ScramjetController was not found in S/SA.js."
        );
    }

    if (typeof veilController.init === "function") {
        await veilController.init();
    }

    veilReady = true;

    window.dispatchEvent(
        new CustomEvent("veilengine-ready", {
            detail: {
                registration,
                controller: veilController
            }
        })
    );

    return veilController;
})().catch(error => {
    veilInitPromise = null;
    veilReady = false;
    throw error;
});

return veilInitPromise;

}

async function createVeilFrame(container, url) {
const controller = await initVeilEngine();

if (!controller || typeof controller.createFrame !== "function") {
    throw new Error("Scramjet frame API is unavailable.");
}

const frameObject = controller.createFrame();

const frame = frameObject.element || frameObject;

if (!(frame instanceof HTMLElement)) {
    throw new Error("Scramjet returned an invalid frame.");
}

frame.style.width = "100%";
frame.style.height = "100%";
frame.style.display = "block";
frame.style.border = "0";

container.replaceChildren(frame);

if (typeof frameObject.go === "function") {
    await frameObject.go(url);
} else if (typeof frameObject.navigate === "function") {
    await frameObject.navigate(url);
} else {
    throw new Error("Scramjet frame navigation API is unavailable.");
}

return frameObject;

}

async function navigateVeil(url) {
if (!url) return;

const value = String(url).trim();

if (!value) return;

let target;

try {
    target = new URL(value);
} catch {
    target = new URL(
        "https://www.google.com/search?q=" +
        encodeURIComponent(value)
    );
}

if (!/^https?:$/.test(target.protocol)) {
    throw new Error("Only HTTP and HTTPS addresses are supported.");
}

return target.href;

}

window.VeilEngine = {
config: VEIL_CONFIG,
init: initVeilEngine,
createFrame: createVeilFrame,
navigate: navigateVeil,

get ready() {
    return veilReady;
},

get controller() {
    return veilController;
}

};

initVeilEngine().catch(error => {
console.error("Veil engine initialization failed:", error);

window.dispatchEvent(
    new CustomEvent("veilengine-error", {
        detail: error
    })
);

});