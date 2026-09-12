import * as BareMux from "./bm/index.mjs";

const WISP_SERVERS = [
    {
        name: "Virginia Server 1",
        url: "wss://wisp-backend-weyl.onrender.com"
    },
    {
        name: "Virginia Server 2",
        url: "wss://backend-0303.onrender.com"
    },
    {
        name: "Ohio Server 3",
        url: "wss://backend-1-da6w.onrender.com"
    },
    {
        name: "Ohio Server 4",
        url: "wss://server4-ecii.onrender.com"
    }
];

const VEIL_ASSETS = {
    scramjetAll: "sj/scramjet.all.js",
    scramjetSync: "sj/scramjet.sync.js",
    scramjetWasm: "sj/scramjet.wasm.wasm",
    epoxy: "ep/index.mjs",
    baremuxWorker: "bm/worker.js",
    serviceWorker: "sw.js"
};

const HOME_PAGE = new URL("./home.html", location.href).href;
const WISP_STORAGE_KEY = "veil-current-wisp";
const CUSTOM_WISP_STORAGE_KEY = "veil-custom-wisp";

let currentWisp = null;
let sharedConnection = null;
let sharedScramjet = null;
let browserInitialized = false;
let tabCounter = 0;
let activeTabId = null;

const tabs = new Map();

function getBasePath() {
    return new URL("./", location.href).href;
}

function normalizeWisp(url) {
    if (!url) return "";

    url = url.trim();

    if (!url) return "";

    if (url.startsWith("http://")) {
        url = "ws://" + url.slice(7);
    } else if (url.startsWith("https://")) {
        url = "wss://" + url.slice(8);
    }

    return url.replace(/\/+$/, "");
}

function getStoredCustomWisp() {
    try {
        return normalizeWisp(
            localStorage.getItem(CUSTOM_WISP_STORAGE_KEY) || ""
        );
    } catch {
        return "";
    }
}

function getCurrentWisp() {
    return currentWisp || normalizeWisp(
        localStorage.getItem(WISP_STORAGE_KEY)
    ) || WISP_SERVERS[0].url;
}

function saveCurrentWisp(url) {
    currentWisp = normalizeWisp(url);

    try {
        localStorage.setItem(WISP_STORAGE_KEY, currentWisp);
    } catch {}

    notifyServiceWorker();
}

async function notifyServiceWorker() {
    try {
        const registration = await navigator.serviceWorker.getRegistration();

        if (!registration) return;

        const worker =
            navigator.serviceWorker.controller ||
            registration.active ||
            registration.waiting ||
            registration.installing;

        if (!worker) return;

        worker.postMessage({
            type: "veil-config",
            wisp: getCurrentWisp()
        });
    } catch (error) {
        console.warn("Unable to update service worker Wisp:", error);
    }
}

async function checkWisp(url) {
    return new Promise(resolve => {
        let socket;

        try {
            socket = new WebSocket(normalizeWisp(url));

            const timeout = setTimeout(() => {
                try {
                    socket.close();
                } catch {}

                resolve(false);
            }, 5000);

            socket.addEventListener("open", () => {
                clearTimeout(timeout);

                try {
                    socket.close();
                } catch {}

                resolve(true);
            });

            socket.addEventListener("error", () => {
                clearTimeout(timeout);
                resolve(false);
            });

            socket.addEventListener("close", event => {
                if (event.wasClean) {
                    clearTimeout(timeout);
                    resolve(true);
                }
            });
        } catch {
            resolve(false);
        }
    });
}

async function initializeWithBestServer() {
    const stored = normalizeWisp(
        localStorage.getItem(WISP_STORAGE_KEY) || ""
    );

    const custom = getStoredCustomWisp();

    const candidates = [];

    if (stored) {
        candidates.push(stored);
    }

    if (custom && !candidates.includes(custom)) {
        candidates.push(custom);
    }

    for (const server of WISP_SERVERS) {
        const url = normalizeWisp(server.url);

        if (!candidates.includes(url)) {
            candidates.push(url);
        }
    }

    for (const url of candidates) {
        if (await checkWisp(url)) {
            saveCurrentWisp(url);
            return url;
        }
    }

    saveCurrentWisp(candidates[0] || WISP_SERVERS[0].url);

    return getCurrentWisp();
}

async function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) {
        throw new Error("Service workers are not supported.");
    }

    const registration = await navigator.serviceWorker.register(
        VEIL_ASSETS.serviceWorker,
        {
            scope: "./"
        }
    );

    await navigator.serviceWorker.ready;

    await notifyServiceWorker();

    return registration;
}

async function getSharedConnection() {
    if (sharedConnection) {
        return sharedConnection;
    }

    sharedConnection = new BareMux.BareMuxConnection(
        getBasePath() + VEIL_ASSETS.baremuxWorker
    );

    await setBareMuxTransport();

    return sharedConnection;
}

async function setBareMuxTransport() {
    if (!sharedConnection) return;

    const wispUrl = getCurrentWisp();

    await sharedConnection.setTransport(
        getBasePath() + VEIL_ASSETS.epoxy,
        [
            {
                wisp: wispUrl
            }
        ]
    );
}

async function getSharedScramjet() {
    if (sharedScramjet) {
        return sharedScramjet;
    }

    let ScramjetControllerClass = window.ScramjetController;

    if (!ScramjetControllerClass && typeof window.$scramjetLoadController === "function") {
        const mod = await window.$scramjetLoadController();

        // Scramjet v1 loader returns an ES module namespace:
        //   Module { ScramjetController, ScramjetFrame }
        if (typeof mod === "function") {
            ScramjetControllerClass = mod;
        } else if (mod && typeof mod === "object") {
            ScramjetControllerClass =
                mod.ScramjetController ||
                mod.default ||
                null;
        }
    }

    if (typeof ScramjetControllerClass !== "function") {
        throw new Error("ScramjetController is unavailable.");
    }

    const basePath = getBasePath();

    sharedScramjet = new ScramjetControllerClass({
        prefix: basePath + "service/",
        files: {
            wasm: basePath + VEIL_ASSETS.scramjetWasm,
            all: basePath + VEIL_ASSETS.scramjetAll,
            sync: basePath + VEIL_ASSETS.scramjetSync
        }
    });

    return sharedScramjet;
}

function $(selector) {
    return document.querySelector(selector);
}

function createTabId() {
    tabCounter++;
    return `tab-${Date.now()}-${tabCounter}`;
}

function createTabElement(id) {
    const tab = document.createElement("div");

    tab.className = "tab";
    tab.dataset.tabId = id;

    tab.innerHTML = `
        <div class="tab-icon">
            <i class="fa-solid fa-globe"></i>
        </div>

        <div class="tab-title">New Tab</div>

        <button class="tab-close" title="Close">
            <i class="fa-solid fa-xmark"></i>
        </button>
    `;

    tab.addEventListener("click", event => {
        if (event.target.closest(".tab-close")) return;
        switchTab(id);
    });

    tab.querySelector(".tab-close").addEventListener("click", event => {
        event.stopPropagation();
        closeTab(id);
    });

    return tab;
}

function updateTabTitle(id, title) {
    const tab = tabs.get(id);

    if (!tab) return;

    const element = tab.element.querySelector(".tab-title");

    if (element) {
        element.textContent =
            title ||
            "New Tab";
    }
}

function updateTabIcon(id, url) {
    const tab = tabs.get(id);

    if (!tab) return;

    const icon = tab.element.querySelector(".tab-icon");

    if (!icon) return;

    icon.innerHTML = `<i class="fa-solid fa-globe"></i>`;

    try {
        const parsed = new URL(url);

        if (
            parsed.protocol === "http:" ||
            parsed.protocol === "https:"
        ) {
            const img = document.createElement("img");

            img.src =
                `https://www.google.com/s2/favicons?domain=${encodeURIComponent(
                    parsed.hostname
                )}&sz=32`;

            img.alt = "";

            img.addEventListener("error", () => {
                icon.innerHTML =
                    `<i class="fa-solid fa-globe"></i>`;
            });

            icon.innerHTML = "";
            icon.appendChild(img);
        }
    } catch {}
}

function updateAddressBar(id) {
    if (activeTabId !== id) return;

    const tab = tabs.get(id);

    if (!tab) return;

    const addressBar = $("#address-bar");

    if (!addressBar) return;

    let url = "";

    try {
        url = tab.frame.frame?.src || "";
    } catch {}

    if (!url || url === "about:blank") {
        addressBar.value = "";
        return;
    }

    addressBar.value = url;
}

function setLoading(visible, title = "Connecting", url = "") {
    const loading = $("#loading");

    if (!loading) return;

    loading.style.display = visible ? "flex" : "none";

    const titleElement = $("#loading-title");
    const urlElement = $("#loading-url");

    if (titleElement) {
        titleElement.textContent = title;
    }

    if (urlElement) {
        urlElement.textContent =
            url || "Initializing proxy...";
    }
}

function setError(message) {
    const error = $("#error");

    if (!error) return;

    const messageElement = $("#error-message");

    if (messageElement) {
        messageElement.textContent =
            message || "An error occurred.";
    }

    error.style.display = "flex";
}

function clearError() {
    const error = $("#error");

    if (error) {
        error.style.display = "none";
    }
}

function setLoadingBar(progress) {
    const bar = $("#loading-bar");

    if (!bar) return;

    if (progress <= 0) {
        bar.style.width = "0%";
        bar.classList.remove("active");
        return;
    }

    bar.classList.add("active");

    bar.style.width =
        Math.max(0, Math.min(100, progress)) + "%";
}

function normalizeNavigationInput(input) {
    input = input.trim();

    if (!input) {
        return HOME_PAGE;
    }

    if (
        input.startsWith("http://") ||
        input.startsWith("https://")
    ) {
        return input;
    }

    if (
        input.startsWith("about:") ||
        input.startsWith("chrome:") ||
        input.startsWith("file:")
    ) {
        return input;
    }

    if (
        input.includes(" ") ||
        !input.includes(".")
    ) {
        return (
            "https://www.google.com/search?q=" +
            encodeURIComponent(input)
        );
    }

    return "https://" + input;
}

function navigateTab(id, target) {
    const tab = tabs.get(id);

    if (!tab || !target) return;

    clearError();

    setLoading(
        true,
        "Connecting",
        target
    );

    setLoadingBar(15);

    try {
        tab.frame.go(target);
    } catch {
        try {
            tab.frame.frame.src = target;
        } catch (error) {
            setLoading(false);
            setLoadingBar(0);
            setError(error.message);
        }
    }
}

function goHome() {
    if (!activeTabId) return;

    const tab = tabs.get(activeTabId);

    if (!tab) return;

    clearError();

    setLoading(
        true,
        "Loading",
        HOME_PAGE
    );

    setLoadingBar(20);

    try {
        tab.frame.frame.src = HOME_PAGE;
    } catch {
        navigateTab(activeTabId, HOME_PAGE);
    }
}

function goBack() {
    const tab = tabs.get(activeTabId);

    if (!tab) return;

    try {
        tab.frame.back();
    } catch {
        try {
            tab.frame.frame.contentWindow.history.back();
        } catch {}
    }
}

function goForward() {
    const tab = tabs.get(activeTabId);

    if (!tab) return;

    try {
        tab.frame.forward();
    } catch {
        try {
            tab.frame.frame.contentWindow.history.forward();
        } catch {}
    }
}

function reloadTab() {
    const tab = tabs.get(activeTabId);

    if (!tab) return;

    clearError();

    setLoading(
        true,
        "Reloading",
        tab.frame.frame?.src || ""
    );

    setLoadingBar(20);

    try {
        tab.frame.reload();
    } catch {
        try {
            tab.frame.frame.src =
                tab.frame.frame.src;
        } catch {}
    }
}

function createTab(url = HOME_PAGE) {
    if (!sharedScramjet) {
        throw new Error("Scramjet has not initialized.");
    }

    const id = createTabId();

    const frame = sharedScramjet.createFrame();

    frame.frame.classList.add("veil-frame");

    const element = createTabElement(id);

    $("#tabs-container").appendChild(element);

    $("#iframe-container").appendChild(frame.frame);

    const tab = {
        id,
        frame,
        element,
        title: "New Tab"
    };

    tabs.set(id, tab);

    frame.addEventListener("urlchange", event => {
        let url = "";

        if (event?.url) {
            url = event.url;
        } else {
            try {
                url = frame.frame.src;
            } catch {}
        }

        if (activeTabId === id) {
            updateAddressBar(id);
        }

        if (url) {
            updateTabIcon(id, url);

            try {
                const parsed = new URL(url);

                if (
                    parsed.hostname &&
                    parsed.hostname !== location.hostname
                ) {
                    updateTabTitle(
                        id,
                        parsed.hostname
                    );
                }
            } catch {}
        }
    });

    frame.addEventListener("load", () => {
        if (activeTabId === id) {
            setLoading(false);
            setLoadingBar(100);

            setTimeout(() => {
                setLoadingBar(0);
            }, 250);

            updateAddressBar(id);
        }

        try {
            const title =
                frame.frame.contentDocument?.title;

            if (title) {
                updateTabTitle(id, title);
            }
        } catch {}
    });

    frame.addEventListener("error", event => {
        if (activeTabId !== id) return;

        setLoading(false);
        setLoadingBar(0);

        setError(
            event?.message ||
            "The requested page could not be loaded."
        );
    });

    switchTab(id);

    try {
        frame.frame.src = url;
    } catch {
        navigateTab(id, url);
    }

    return id;
}

function switchTab(id) {
    const tab = tabs.get(id);

    if (!tab) return;

    activeTabId = id;

    for (const [tabId, current] of tabs) {
        const active = tabId === id;

        current.element.classList.toggle(
            "active",
            active
        );

        current.frame.frame.style.display =
            active ? "block" : "none";
    }

    updateAddressBar(id);
}

function closeTab(id) {
    const tab = tabs.get(id);

    if (!tab) return;

    const ids = Array.from(tabs.keys());
    const index = ids.indexOf(id);

    try {
        tab.frame.frame.remove();
    } catch {}

    try {
        tab.element.remove();
    } catch {}

    tabs.delete(id);

    if (tabs.size === 0) {
        createTab(HOME_PAGE);
        return;
    }

    if (activeTabId === id) {
        const remaining = Array.from(tabs.keys());

        const next =
            remaining[
                Math.max(
                    0,
                    Math.min(
                        index - 1,
                        remaining.length - 1
                    )
                )
            ];

        switchTab(next);
    }
}

function showWispModal() {
    const modal = $("#wisp-settings-modal");

    if (!modal) return;

    renderWispServers();

    modal.classList.remove("hidden");
}

function hideWispModal() {
    const modal = $("#wisp-settings-modal");

    if (modal) {
        modal.classList.add("hidden");
    }
}

function renderWispServers() {
    const list = $("#server-list");

    if (!list) return;

    list.innerHTML = "";

    const current = getCurrentWisp();

    for (const server of WISP_SERVERS) {
        const url = normalizeWisp(server.url);

        const button = document.createElement("button");

        button.className =
            "wisp-server" +
            (url === current ? " active" : "");

        button.innerHTML = `
            <span>${server.name}</span>
            <small>${url}</small>
        `;

        button.addEventListener("click", async () => {
            saveCurrentWisp(url);

            try {
                await setBareMuxTransport();
            } catch (error) {
                console.warn(
                    "Failed to update page BareMux:",
                    error
                );
            }

            renderWispServers();
        });

        list.appendChild(button);
    }

    const custom = getStoredCustomWisp();

    if (custom) {
        const button = document.createElement("button");

        button.className =
            "wisp-server" +
            (custom === current ? " active" : "");

        button.innerHTML = `
            <span>Custom Server</span>
            <small>${custom}</small>
        `;

        button.addEventListener("click", async () => {
            saveCurrentWisp(custom);

            try {
                await setBareMuxTransport();
            } catch {}

            renderWispServers();
        });

        list.appendChild(button);
    }
}

async function saveCustomWisp() {
    const input = $("#custom-wisp-input");

    if (!input) return;

    const value = normalizeWisp(input.value);

    if (!value) return;

    try {
        localStorage.setItem(
            CUSTOM_WISP_STORAGE_KEY,
            value
        );
    } catch {}

    saveCurrentWisp(value);

    try {
        await setBareMuxTransport();
    } catch (error) {
        console.warn(
            "Failed to set custom Wisp:",
            error
        );
    }

    input.value = "";

    renderWispServers();
}

function openDevTools() {
    if (window.eruda) {
        window.eruda.show();
        return;
    }

    const script = document.createElement("script");

    script.src =
        "https://cdn.jsdelivr.net/npm/eruda";

    script.onload = () => {
        try {
            window.eruda.init();
            window.eruda.show();
        } catch {}
    };

    document.head.appendChild(script);
}

function bindNavigation() {
    $("#back-btn")?.addEventListener(
        "click",
        goBack
    );

    $("#fwd-btn")?.addEventListener(
        "click",
        goForward
    );

    $("#reload-btn")?.addEventListener(
        "click",
        reloadTab
    );

    $("#home-btn-nav")?.addEventListener(
        "click",
        goHome
    );

    $("#devtools-btn")?.addEventListener(
        "click",
        openDevTools
    );

    $("#wisp-settings-btn")?.addEventListener(
        "click",
        showWispModal
    );

    $("#close-wisp-modal")?.addEventListener(
        "click",
        hideWispModal
    );

    $("#save-custom-wisp")?.addEventListener(
        "click",
        saveCustomWisp
    );

    $("#skip-btn")?.addEventListener(
        "click",
        () => {
            setLoading(false);
            setLoadingBar(0);
        }
    );

    const addressBar = $("#address-bar");

    addressBar?.addEventListener(
        "keydown",
        event => {
            if (event.key !== "Enter") return;

            const target =
                normalizeNavigationInput(
                    addressBar.value
                );

            navigateTab(
                activeTabId,
                target
            );

            addressBar.blur();
        }
    );

    addressBar?.addEventListener(
        "focus",
        () => {
            addressBar.select();
        }
    );
}

function bindTabControls() {
    $("#new-tab")?.addEventListener(
        "click",
        () => createTab(HOME_PAGE)
    );
}

function bindMessages() {
    window.addEventListener(
        "message",
        event => {
            if (!event.data) return;

            if (
                event.data.type === "navigate" &&
                typeof event.data.url === "string"
            ) {
                navigateTab(
                    activeTabId,
                    normalizeNavigationInput(
                        event.data.url
                    )
                );
            }
        }
    );
}

async function initializeBrowser() {
    if (browserInitialized) return;

    browserInitialized = true;

    bindNavigation();
    bindTabControls();
    bindMessages();

    createTab(HOME_PAGE);
}

async function initialize() {
    try {
        await initializeWithBestServer();
        await registerServiceWorker();
        await getSharedConnection();
        await getSharedScramjet();
        await initializeBrowser();

        console.log(
            "Veil initialized with Wisp:",
            getCurrentWisp()
        );
    } catch (error) {
        console.error(
            "Veil initialization failed:",
            error
        );

        setLoading(false);
        setLoadingBar(0);

        setError(
            error?.message ||
            "The Veil browser engine could not initialize."
        );
    }
}

initialize();