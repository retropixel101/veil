// =====================================================
// VEIL CONFIGURATION
// =====================================================

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

// First server is the default Veil server.
const DEFAULT_WISP = WISP_SERVERS[0].url;


// =====================================================
// VEIL LOCAL ASSETS
// =====================================================

const VEIL_ASSETS = {
    scramjetAll: "sj/scramjet.all.js",
    scramjetSync: "sj/scramjet.sync.js",
    scramjetWasm: "sj/scramjet.wasm.wasm",

    epoxy: "ep/index.mjs",
    baremuxWorker: "bm/worker.js",

    serviceWorker: "sw.js"
};


// =====================================================
// WISP STORAGE
// =====================================================

const getStoredWisps = () => {
    try {
        const stored = JSON.parse(
            localStorage.getItem("customWisps") || "[]"
        );

        return Array.isArray(stored) ? stored : [];
    } catch {
        return [];
    }
};


// Normalize user-entered server URLs.
//
// Accepts:
//
// https://example.com
// http://example.com
// wss://example.com
// ws://example.com
//
// Internally Veil uses Wisp WebSocket URLs.
function normalizeWispUrl(url) {
    let value = String(url || "").trim();

    if (!value) {
        return "";
    }

    if (value.startsWith("https://")) {
        value = "wss://" + value.slice(8);
    } else if (value.startsWith("http://")) {
        value = "ws://" + value.slice(7);
    }

    return value.replace(/\/+$/, "");
};


// Return every available server.
function getAllWispServers() {
    return [
        ...WISP_SERVERS,
        ...getStoredWisps()
    ];
};


// Make sure an existing old server selection does not survive.
function initializeWispStorage() {
    const stored = localStorage.getItem("proxServer");

    // Remove the old GLSeries server if it was previously saved.
    if (
        !stored ||
        stored.includes("glseries.net")
    ) {
        localStorage.setItem(
            "proxServer",
            DEFAULT_WISP
        );
    }
}

initializeWispStorage();


// =====================================================
// SERVER HEALTH CHECKING
// =====================================================

async function pingWispServer(
    url,
    timeout = 2500
) {
    return new Promise((resolve) => {

        const normalized = normalizeWispUrl(url);
        const start = Date.now();

        let finished = false;

        const finish = (result) => {
            if (finished) return;

            finished = true;
            resolve(result);
        };

        try {

            const ws = new WebSocket(normalized);

            const timer = setTimeout(() => {

                try {
                    ws.close();
                } catch {}

                finish({
                    url: normalized,
                    success: false,
                    latency: null
                });

            }, timeout);

            ws.onopen = () => {

                clearTimeout(timer);

                const latency =
                    Date.now() - start;

                try {
                    ws.close();
                } catch {}

                finish({
                    url: normalized,
                    success: true,
                    latency
                });
            };

            ws.onerror = () => {

                clearTimeout(timer);

                try {
                    ws.close();
                } catch {}

                finish({
                    url: normalized,
                    success: false,
                    latency: null
                });
            };

            ws.onclose = () => {

                if (!finished) {
                    clearTimeout(timer);

                    finish({
                        url: normalized,
                        success: false,
                        latency: null
                    });
                }
            };

        } catch {

            finish({
                url: normalized,
                success: false,
                latency: null
            });
        }
    });
};


// =====================================================
// FIND FASTEST WORKING SERVER
// =====================================================

async function findBestWispServer(
    servers,
    currentUrl
) {
    if (
        !servers ||
        servers.length === 0
    ) {
        return currentUrl;
    }

    const results = await Promise.all(
        servers.map(server =>
            pingWispServer(
                server.url,
                2500
            )
        )
    );

    const working = results
        .filter(result => result.success)
        .sort(
            (a, b) =>
                a.latency - b.latency
        );

    if (working.length > 0) {
        return working[0].url;
    }

    return (
        currentUrl ||
        DEFAULT_WISP
    );
};


// =====================================================
// AUTOMATIC SERVER SELECTION
// =====================================================

async function initializeWithBestServer() {

    const autoswitch =
        localStorage.getItem(
            "wispAutoswitch"
        ) !== "false";

    if (!autoswitch) {
        return;
    }

    const servers =
        getAllWispServers();

    if (servers.length <= 1) {
        return;
    }

    const currentUrl =
        normalizeWispUrl(
            localStorage.getItem(
                "proxServer"
            ) || DEFAULT_WISP
        );

    const currentCheck =
        await pingWispServer(
            currentUrl,
            2500
        );

    if (currentCheck.success) {

        console.log(
            "Veil: current Wisp is working:",
            currentUrl,
            `${currentCheck.latency}ms`
        );

        return;
    }

    console.warn(
        "Veil: current Wisp is unavailable. Searching for another server..."
    );

    const best =
        await findBestWispServer(
            servers,
            currentUrl
        );

    if (
        best &&
        best !== currentUrl
    ) {

        localStorage.setItem(
            "proxServer",
            best
        );

        const server =
            servers.find(
                item =>
                    item.url === best
            );

        notify(
            "info",
            "Server Changed",
            `Using ${server?.name || "another Veil server"}`
        );
    }
}


// =====================================================
// BAREMUX
// =====================================================

const BareMux =
    window.BareMux ?? {
        BareMuxConnection:
            class {
                async setTransport() {}
            }
    };


// =====================================================
// SHARED BROWSER ENGINE
// =====================================================

let sharedScramjet = null;

let sharedConnection = null;

let sharedConnectionReady = false;

let tabs = [];

let activeTabId = null;

let nextTabId = 1;


// =====================================================
// UTILITIES
// =====================================================

const getBasePath = () => {

    const path =
        location.pathname.replace(
            /[^/]*$/,
            ""
        );

    return path.endsWith("/")
        ? path
        : path + "/";
};


const getActiveTab = () =>
    tabs.find(
        tab =>
            tab.id === activeTabId
    );


const notify = (
    type,
    title,
    message
) => {

    if (
        typeof Notify !==
        "undefined" &&
        Notify[type]
    ) {
        Notify[type](
            title,
            message
        );
    }
};


// =====================================================
// SCRAMJET INITIALIZATION
// =====================================================

async function getSharedScramjet() {

    if (sharedScramjet) {
        return sharedScramjet;
    }

    const basePath =
        getBasePath();

    if (
        typeof $scramjetLoadController !==
        "function"
    ) {
        throw new Error(
            "Veil Scramjet controller could not be loaded."
        );
    }

    const {
        ScramjetController
    } = $scramjetLoadController();

    sharedScramjet =
        new ScramjetController({

            prefix:
                basePath +
                "service/",

            files: {

                wasm:
                    basePath +
                    VEIL_ASSETS.scramjetWasm,

                all:
                    basePath +
                    VEIL_ASSETS.scramjetAll,

                sync:
                    basePath +
                    VEIL_ASSETS.scramjetSync
            }
        });

    try {

        await sharedScramjet.init();

    } catch (err) {

        const message =
            String(
                err?.message ||
                err
            );

        if (
            message.includes(
                "IDBDatabase"
            ) ||
            message.includes(
                "object stores"
            )
        ) {

            console.warn(
                "Veil: Scramjet IndexedDB error. Clearing database..."
            );

            try {

                const dbNames = [
                    "scramjet-data",
                    "scrambase",
                    "ScramjetData"
                ];

                for (
                    const dbName
                    of dbNames
                ) {

                    const request =
                        indexedDB.deleteDatabase(
                            dbName
                        );

                    request.onsuccess =
                        () =>
                            console.log(
                                `Veil: cleared ${dbName}`
                            );

                    request.onerror =
                        () =>
                            console.warn(
                                `Veil: failed to clear ${dbName}`
                            );
                }

            } catch (clearError) {

                console.warn(
                    "Veil: could not clear IndexedDB:",
                    clearError
                );
            }

            sharedScramjet = null;

            return getSharedScramjet();
        }

        throw err;
    }

    return sharedScramjet;
}


// =====================================================
// BAREMUX / EPOXY INITIALIZATION
// =====================================================

async function getSharedConnection() {

    if (
        sharedConnectionReady &&
        sharedConnection
    ) {
        return sharedConnection;
    }

    const basePath =
        getBasePath();

    const wispUrl =
        normalizeWispUrl(
            localStorage.getItem(
                "proxServer"
            ) || DEFAULT_WISP
        );

    sharedConnection =
        new BareMux.BareMuxConnection(
            basePath +
            VEIL_ASSETS.baremuxWorker
        );

    await sharedConnection.setTransport(
        basePath +
        VEIL_ASSETS.epoxy,
        [
            {
                wisp: wispUrl
            }
        ]
    );

    sharedConnectionReady = true;

    console.log(
        "Veil: Epoxy transport initialized.",
        wispUrl
    );

    return sharedConnection;
}


// =====================================================
// BROWSER UI
// =====================================================

async function initializeBrowser() {

    const root =
        document.getElementById(
            "app"
        );

    if (!root) {
        throw new Error(
            "Veil browser root #app was not found."
        );
    }

    root.innerHTML = `
        <div class="browser-container">

            <div
                class="flex tabs"
                id="tabs-container"
            ></div>

            <div class="flex nav">

                <button
                    id="back-btn"
                    title="Back"
                >
                    <i class="fa-solid fa-chevron-left"></i>
                </button>

                <button
                    id="fwd-btn"
                    title="Forward"
                >
                    <i class="fa-solid fa-chevron-right"></i>
                </button>

                <button
                    id="reload-btn"
                    title="Reload"
                >
                    <i class="fa-solid fa-rotate-right"></i>
                </button>

                <div class="address-wrapper">

                    <input
                        class="bar"
                        id="address-bar"
                        autocomplete="off"
                        placeholder="Search or enter URL"
                    >

                    <button
                        id="home-btn-nav"
                        title="Home"
                    >
                        <i class="fa-solid fa-house"></i>
                    </button>

                </div>

                <button
                    id="devtools-btn"
                    title="DevTools"
                >
                    <i class="fa-solid fa-code"></i>
                </button>

                <button
                    id="wisp-settings-btn"
                    title="Veil Servers"
                >
                    <i class="fa-solid fa-server"></i>
                </button>

            </div>

            <div class="loading-bar-container">
                <div
                    class="loading-bar"
                    id="loading-bar"
                ></div>
            </div>

            <div
                class="iframe-container"
                id="iframe-container"
            >

                <div
                    id="loading"
                    class="message-container"
                    style="display:none;"
                >

                    <div class="message-content">

                        <div class="spinner"></div>

                        <h1 id="loading-title">
                            Connecting
                        </h1>

                        <p id="loading-url">
                            Initializing Veil...
                        </p>

                        <button id="skip-btn">
                            Skip
                        </button>

                    </div>

                </div>

                <div
                    id="error"
                    class="message-container"
                    style="display:none;"
                >

                    <div class="message-content">

                        <h1>
                            Connection Error
                        </h1>

                        <p id="error-message">
                            An error occurred.
                        </p>

                    </div>

                </div>

            </div>

        </div>
    `;


    const elements = {

        backBtn:
            document.getElementById(
                "back-btn"
            ),

        fwdBtn:
            document.getElementById(
                "fwd-btn"
            ),

        reloadBtn:
            document.getElementById(
                "reload-btn"
            ),

        addrBar:
            document.getElementById(
                "address-bar"
            ),

        skipBtn:
            document.getElementById(
                "skip-btn"
            )
    };


    elements.backBtn.onclick =
        () =>
            getActiveTab()
                ?.frame
                .back();


    elements.fwdBtn.onclick =
        () =>
            getActiveTab()
                ?.frame
                .forward();


    elements.reloadBtn.onclick =
        () =>
            getActiveTab()
                ?.frame
                .reload();


    document
        .getElementById(
            "home-btn-nav"
        )
        .onclick = () => {

            window.location.href =
                "./index.html";
        };


    document
        .getElementById(
            "devtools-btn"
        )
        .onclick =
        toggleDevTools;


    document
        .getElementById(
            "wisp-settings-btn"
        )
        .onclick =
        openSettings;


    elements.skipBtn.onclick =
        () => {

            const tab =
                getActiveTab();

            if (!tab) {
                return;
            }

            tab.loading = false;

            showIframeLoading(
                false
            );
        };


    elements.addrBar.onkeyup =
        event => {

            if (
                event.key ===
                "Enter"
            ) {
                handleSubmit();
            }
        };


    elements.addrBar.onfocus =
        () =>
            elements.addrBar.select();


    window.addEventListener(
        "message",
        event => {

            if (
                event.data?.type ===
                "navigate"
            ) {

                handleSubmit(
                    event.data.url
                );
            }
        }
    );


    createTab(true);

    checkHashParameters();
}


// =====================================================
// TAB MANAGEMENT
// =====================================================

function createTab(
    makeActive = true
) {

    const frame =
        sharedScramjet.createFrame();

    const tab = {

        id:
            nextTabId++,

        title:
            "New Tab",

        url:
            "NT.html",

        frame,

        loading:
            false,

        favicon:
            null,

        skipTimeout:
            null,

        loadStartTime:
            null
    };


    frame.frame.src =
        "NT.html";


    frame.addEventListener(
        "urlchange",
        event => {

            tab.url =
                event.url;

            tab.loading =
                true;

            tab.loadStartTime =
                Date.now();


            if (
                tab.id ===
                activeTabId
            ) {

                showIframeLoading(
                    true,
                    tab.url
                );
            }


            try {

                const url =
                    new URL(
                        event.url
                    );

                tab.title =
                    url.hostname;

                tab.favicon =
                    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(
                        url.hostname
                    )}&sz=32`;

            } catch {

                tab.title =
                    "Browsing";

                tab.favicon =
                    null;
            }


            updateTabsUI();

            updateAddressBar();

            updateLoadingBar(
                tab,
                10
            );


            if (
                tab.skipTimeout
            ) {
                clearTimeout(
                    tab.skipTimeout
                );
            }


            tab.skipTimeout =
                setTimeout(
                    () => {

                        if (
                            tab.loading &&
                            tab.id ===
                            activeTabId
                        ) {

                            const button =
                                document.getElementById(
                                    "skip-btn"
                                );

                            if (button) {
                                button.style.display =
                                    "inline-block";
                            }
                        }

                    },
                    3000
                );
        }
    );


    frame.frame.addEventListener(
        "load",
        () => {

            tab.loading =
                false;

            clearTimeout(
                tab.skipTimeout
            );


            if (
                tab.id ===
                activeTabId
            ) {

                showIframeLoading(
                    false
                );
            }


            try {

                const title =
                    frame.frame
                        .contentWindow
                        .document
                        .title;

                if (title) {
                    tab.title =
                        title;
                }

            } catch {}


            try {

                if (
                    frame.frame
                        .contentWindow
                        .location
                        .href
                        .includes(
                            "NT.html"
                        )
                ) {

                    tab.title =
                        "New Tab";

                    tab.url =
                        "";

                    tab.favicon =
                        null;
                }

            } catch {}


            updateTabsUI();

            updateAddressBar();

            updateLoadingBar(
                tab,
                100
            );
        }
    );


    tabs.push(tab);


    document
        .getElementById(
            "iframe-container"
        )
        .appendChild(
            frame.frame
        );


    if (makeActive) {
        switchTab(tab.id);
    }


    return tab;
}


// =====================================================
// LOADING UI
// =====================================================

function showIframeLoading(
    show,
    url = ""
) {

    const loader =
        document.getElementById(
            "loading"
        );

    if (!loader) {
        return;
    }


    loader.style.display =
        show
            ? "flex"
            : "none";


    const active =
        getActiveTab();


    active?.frame?.frame
        ?.classList
        .toggle(
            "loading",
            show
        );


    if (show) {

        document.getElementById(
            "loading-title"
        ).textContent =
            "Connecting";


        document.getElementById(
            "loading-url"
        ).textContent =
            url ||
            "Loading content...";


        document.getElementById(
            "skip-btn"
        ).style.display =
            "none";
    }
}


// =====================================================
// SWITCH TAB
// =====================================================

function switchTab(
    tabId
) {

    activeTabId =
        tabId;

    const tab =
        getActiveTab();


    tabs.forEach(
        current => {

            current.frame
                .frame
                .classList
                .toggle(
                    "hidden",
                    current.id !==
                    tabId
                );
        }
    );


    if (tab) {

        showIframeLoading(
            tab.loading,
            tab.url
        );


        const skip =
            document.getElementById(
                "skip-btn"
            );


        if (
            tab.loading &&
            tab.loadStartTime &&
            skip
        ) {

            const elapsed =
                Date.now() -
                tab.loadStartTime;


            if (
                elapsed >
                3000
            ) {

                skip.style.display =
                    "inline-block";
            }
        }
    }


    updateTabsUI();

    updateAddressBar();
}


// =====================================================
// CLOSE TAB
// =====================================================

function closeTab(
    tabId
) {

    const index =
        tabs.findIndex(
            tab =>
                tab.id ===
                tabId
        );


    if (index === -1) {
        return;
    }


    const tab =
        tabs[index];


    clearTimeout(
        tab.skipTimeout
    );


    if (tab.frame?.frame) {

        tab.frame.frame.src =
            "about:blank";

        tab.frame.frame.remove();
    }


    tabs.splice(
        index,
        1
    );


    if (
        activeTabId ===
        tabId
    ) {

        if (tabs.length) {

            switchTab(
                tabs[
                    Math.max(
                        0,
                        index - 1
                    )
                ].id
            );

        } else {

            createTab(true);
        }

    } else {

        updateTabsUI();
    }
}


// =====================================================
// TAB UI
// =====================================================

function updateTabsUI() {

    const container =
        document.getElementById(
            "tabs-container"
        );

    if (!container) {
        return;
    }


    container.innerHTML =
        "";


    tabs.forEach(
        tab => {

            const element =
                document.createElement(
                    "div"
                );


            element.className =
                `tab ${
                    tab.id ===
                    activeTabId
                        ? "active"
                        : ""
                }`;


            const icon =
                tab.loading

                    ? `
                        <div class="tab-spinner"></div>
                      `

                    : tab.favicon

                        ? `
                            <img
                                src="${tab.favicon}"
                                class="tab-favicon"
                                onerror="this.style.display='none'"
                            >
                          `

                        : "";


            element.innerHTML = `
                ${icon}

                <span class="tab-title">
                    ${escapeHtml(
                        tab.title
                    )}
                </span>

                <span class="tab-close">
                    ×
                </span>
            `;


            element.onclick =
                () =>
                    switchTab(
                        tab.id
                    );


            element
                .querySelector(
                    ".tab-close"
                )
                .onclick =
                event => {

                    event.stopPropagation();

                    closeTab(
                        tab.id
                    );
                };


            container.appendChild(
                element
            );
        }
    );


    const newButton =
        document.createElement(
            "button"
        );


    newButton.className =
        "new-tab";


    newButton.innerHTML =
        "+";


    newButton.title =
        "New Tab";


    newButton.onclick =
        () =>
            createTab(true);


    container.appendChild(
        newButton
    );
}


// Prevent titles from injecting HTML.
function escapeHtml(value) {

    return String(value)
        .replaceAll(
            "&",
            "&amp;"
        )
        .replaceAll(
            "<",
            "&lt;"
        )
        .replaceAll(
            ">",
            "&gt;"
        )
        .replaceAll(
            '"',
            "&quot;"
        )
        .replaceAll(
            "'",
            "&#039;"
        );
}


// =====================================================
// ADDRESS BAR
// =====================================================

function updateAddressBar() {

    const bar =
        document.getElementById(
            "address-bar"
        );

    const tab =
        getActiveTab();


    if (
        bar &&
        tab
    ) {

        bar.value =
            tab.url &&
            !tab.url.includes(
                "NT.html"
            )
                ? tab.url
                : "";
    }
}


// =====================================================
// NAVIGATION
// =====================================================

function handleSubmit(
    url
) {

    const tab =
        getActiveTab();

    if (!tab) {
        return;
    }


    let input =
        url ??
        document
            .getElementById(
                "address-bar"
            )
            .value
            .trim();


    if (!input) {
        return;
    }


    if (
        !/^https?:\/\//i.test(
            input
        )
    ) {

        input =
            input.includes(".") &&
            !input.includes(" ")

                ? `https://${input}`

                : `https://search.brave.com/search?q=${encodeURIComponent(
                    input
                  )}`;
    }


    tab.loading =
        true;


    showIframeLoading(
        true,
        input
    );


    updateLoadingBar(
        tab,
        10
    );


    tab.frame.go(
        input
    );
}


// =====================================================
// LOADING BAR
// =====================================================

function updateLoadingBar(
    tab,
    percent
) {

    if (
        !tab ||
        tab.id !==
        activeTabId
    ) {
        return;
    }


    const bar =
        document.getElementById(
            "loading-bar"
        );


    if (!bar) {
        return;
    }


    bar.style.width =
        `${percent}%`;


    bar.style.opacity =
        percent === 100
            ? "0"
            : "1";


    if (
        percent === 100
    ) {

        setTimeout(
            () => {

                bar.style.width =
                    "0%";

            },
            200
        );
    }
}


// =====================================================
// SERVER SETTINGS
// =====================================================

function openSettings() {

    const modal =
        document.getElementById(
            "wisp-settings-modal"
        );

    if (!modal) {
        return;
    }


    modal.classList.remove(
        "hidden"
    );


    const close =
        document.getElementById(
            "close-wisp-modal"
        );


    if (close) {

        close.onclick =
            () =>
                modal.classList.add(
                    "hidden"
                );
    }


    const save =
        document.getElementById(
            "save-custom-wisp"
        );


    if (save) {

        save.onclick =
            saveCustomWisp;
    }


    modal.onclick =
        event => {

            if (
                event.target ===
                modal
            ) {

                modal.classList.add(
                    "hidden"
                );
            }
        };


    renderServerList();
}


// =====================================================
// SERVER LIST
// =====================================================

function renderServerList() {

    const list =
        document.getElementById(
            "server-list"
        );

    if (!list) {
        return;
    }


    list.innerHTML =
        "";


    const currentUrl =
        normalizeWispUrl(
            localStorage.getItem(
                "proxServer"
            ) ||
            DEFAULT_WISP
        );


    const servers =
        getAllWispServers();


    servers.forEach(
        (server, index) => {

            const serverUrl =
                normalizeWispUrl(
                    server.url
                );


            const active =
                serverUrl ===
                currentUrl;


            const isCustom =
                index >=
                WISP_SERVERS.length;


            const item =
                document.createElement(
                    "div"
                );


            item.className =
                `wisp-option ${
                    active
                        ? "active"
                        : ""
                }`;


            const deleteButton =
                isCustom
                    ? `
                        <button
                            class="delete-wisp-btn"
                            data-delete-wisp="${encodeURIComponent(
                                serverUrl
                            )}"
                            title="Remove server"
                        >
                            <i class="fa-solid fa-trash"></i>
                        </button>
                      `
                    : "";


            item.innerHTML = `
                <div class="wisp-option-header">

                    <div class="wisp-option-name">

                        ${escapeHtml(
                            server.name
                        )}

                        ${
                            active
                                ? `
                                    <i
                                        class="fa-solid fa-check"
                                        style="
                                            margin-left:8px;
                                            font-size:.7em;
                                            color:var(--accent,#fff);
                                        "
                                    ></i>
                                  `
                                : ""
                        }

                    </div>

                    <div class="server-status">

                        <span class="ping-text">
                            Checking...
                        </span>

                        <div class="status-indicator"></div>

                        ${deleteButton}

                    </div>

                </div>

                <div class="wisp-option-url">
                    ${escapeHtml(
                        serverUrl
                    )}
                </div>
            `;


            item.onclick =
                () =>
                    setWisp(
                        serverUrl
                    );


            const deleteElement =
                item.querySelector(
                    "[data-delete-wisp]"
                );


            if (deleteElement) {

                deleteElement.onclick =
                    event => {

                        event.stopPropagation();

                        deleteCustomWisp(
                            serverUrl
                        );
                    };
            }


            list.appendChild(
                item
            );


            checkServerHealth(
                serverUrl,
                item
            );
        }
    );


    // =================================================
    // CUSTOM SERVER INPUT
    // =================================================

    const customSection =
        document.createElement(
            "div"
        );


    customSection.className =
        "wisp-custom-section";


    customSection.innerHTML = `
        <div class="wisp-custom-title">
            Custom Server
        </div>

        <div class="wisp-custom-row">

            <input
                id="custom-wisp-input"
                class="text-input"
                type="text"
                placeholder="https://your-wisp-server.com"
                autocomplete="off"
            >

            <button
                id="save-custom-wisp"
                class="primary-btn"
                type="button"
            >
                Add
            </button>

        </div>

        <div class="wisp-custom-help">
            Enter a Wisp server URL. Veil automatically
            converts HTTPS URLs to WSS.
        </div>
    `;


    list.appendChild(
        customSection
    );


    document
        .getElementById(
            "save-custom-wisp"
        )
        ?.addEventListener(
            "click",
            saveCustomWisp
        );


    // =================================================
    // AUTO-SWITCH
    // =================================================

    const autoswitch =
        localStorage.getItem(
            "wispAutoswitch"
        ) !== "false";


    const toggle =
        document.createElement(
            "div"
        );


    toggle.className =
        "wisp-option";


    toggle.style.cssText =
        "margin-top:10px;cursor:default;";


    toggle.innerHTML = `
        <div
            class="wisp-option-header"
            style="justify-content:space-between;"
        >

            <div class="wisp-option-name">

                <i
                    class="fa-solid fa-rotate"
                    style="margin-right:8px"
                ></i>

                Auto-switch on failure

            </div>

            <div
                class="toggle-switch ${
                    autoswitch
                        ? "active"
                        : ""
                }"
                id="autoswitch-toggle"
            >

                <div class="toggle-knob"></div>

            </div>

        </div>
    `;


    toggle.onclick =
        () => {

            const state =
                localStorage.getItem(
                    "wispAutoswitch"
                ) !== "false";


            const next =
                !state;


            localStorage.setItem(
                "wispAutoswitch",
                String(next)
            );


            notify(
                "success",
                "Settings Saved",
                `Auto-switch ${
                    next
                        ? "enabled"
                        : "disabled"
                }`
            );


            renderServerList();
        };


    list.appendChild(
        toggle
    );
}


// =====================================================
// ADD CUSTOM WISP
// =====================================================

function saveCustomWisp() {

    const input =
        document.getElementById(
            "custom-wisp-input"
        );


    if (!input) {
        return;
    }


    const raw =
        input.value.trim();


    if (!raw) {
        return;
    }


    const url =
        normalizeWispUrl(
            raw
        );


    if (
        !/^wss?:\/\//i.test(
            url
        )
    ) {

        notify(
            "error",
            "Invalid Server",
            "Enter a valid Wisp server URL."
        );

        return;
    }


    const builtIn =
        WISP_SERVERS.some(
            server =>
                normalizeWispUrl(
                    server.url
                ) === url
        );


    const custom =
        getStoredWisps();


    const alreadyExists =
        custom.some(
            server =>
                normalizeWispUrl(
                    server.url
                ) === url
        );


    if (
        builtIn ||
        alreadyExists
    ) {

        notify(
            "warning",
            "Already Exists",
            "That server is already in Veil."
        );

        return;
    }


    const newServer = {

        name:
            `Custom Server ${custom.length + 1}`,

        url
    };


    custom.push(
        newServer
    );


    localStorage.setItem(
        "customWisps",
        JSON.stringify(
            custom
        )
    );


    input.value =
        "";


    setWisp(
        url
    );
}


// =====================================================
// DELETE CUSTOM SERVER
// =====================================================

window.deleteCustomWisp =
    function(urlToDelete) {

        const url =
            normalizeWispUrl(
                urlToDelete
            );


        if (
            !confirm(
                "Remove this custom server?"
            )
        ) {
            return;
        }


        const remaining =
            getStoredWisps()
                .filter(
                    server =>
                        normalizeWispUrl(
                            server.url
                        ) !== url
                );


        localStorage.setItem(
            "customWisps",
            JSON.stringify(
                remaining
            )
        );


        if (
            normalizeWispUrl(
                localStorage.getItem(
                    "proxServer"
                )
            ) === url
        ) {

            setWisp(
                DEFAULT_WISP
            );

        } else {

            renderServerList();
        }
    };


// =====================================================
// SERVER HEALTH
// =====================================================

async function checkServerHealth(
    url,
    element
) {

    const dot =
        element.querySelector(
            ".status-indicator"
        );


    const text =
        element.querySelector(
            ".ping-text"
        );


    if (
        !dot ||
        !text
    ) {
        return;
    }


    const start =
        Date.now();


    const markOffline =
        () => {

            dot.classList.add(
                "status-error"
            );

            text.textContent =
                "Offline";
        };


    try {

        const result =
            await pingWispServer(
                url,
                2500
            );


        if (
            result.success
        ) {

            dot.classList.add(
                "status-success"
            );

            text.textContent =
                `${result.latency}ms`;

        } else {

            markOffline();
        }

    } catch {

        markOffline();
    }
}


// =====================================================
// CHANGE WISP
// =====================================================

async function setWisp(
    url
) {

    const normalized =
        normalizeWispUrl(
            url
        );


    if (!normalized) {
        return;
    }


    const oldUrl =
        normalizeWispUrl(
            localStorage.getItem(
                "proxServer"
            )
        );


    localStorage.setItem(
        "proxServer",
        normalized
    );


    const server =
        getAllWispServers()
            .find(
                item =>
                    normalizeWispUrl(
                        item.url
                    ) === normalized
            );


    if (
        oldUrl !== normalized
    ) {

        notify(
            "success",
            "Server Changed",
            `Using ${
                server?.name ||
                "Custom Server"
            }`
        );
    }


    // Tell the service worker too.
    //
    // This is supported by the Veil configuration
    // message handler when the SW is updated to accept
    // dynamic Wisp servers.
    navigator.serviceWorker
        ?.controller
        ?.postMessage({
            type:
                "config",

            typeLegacy:
                "veil-config",

            wispurl:
                normalized
        });


    // Force the connection singleton to use
    // the newly selected Wisp.
    sharedConnection =
        null;

    sharedConnectionReady =
        false;


    setTimeout(
        () =>
            location.reload(),
        350
    );
}


// =====================================================
// DEVTOOLS
// =====================================================

function toggleDevTools() {

    const win =
        getActiveTab()
            ?.frame
            ?.frame
            ?.contentWindow;


    if (!win) {
        return;
    }


    if (win.eruda) {

        win.eruda.show();

        return;
    }


    try {

        const script =
            win.document.createElement(
                "script"
            );


        script.src =
            "https://cdn.jsdelivr.net/npm/eruda";


        script.onload =
            () => {

                win.eruda.init();

                win.eruda.show();
            };


        win.document.body.appendChild(
            script
        );

    } catch (error) {

        console.error(
            "Veil DevTools error:",
            error
        );
    }
}


// =====================================================
// HASH NAVIGATION
// =====================================================

async function checkHashParameters() {

    if (!window.location.hash) {
        return;
    }


    try {

        const hash =
            decodeURIComponent(
                window.location.hash.substring(
                    1
                )
            );


        if (hash) {
            handleSubmit(hash);
        }


        history.replaceState(
            null,
            "",
            location.pathname
        );

    } catch (error) {

        console.warn(
            "Veil: invalid hash:",
            error
        );
    }
}


// =====================================================
// SERVICE WORKER
// =====================================================

async function initializeServiceWorker() {

    if (
        !("serviceWorker" in navigator)
    ) {
        console.warn(
            "Veil: Service Workers are unavailable."
        );

        return null;
    }


    const basePath =
        getBasePath();


    const registration =
        await navigator.serviceWorker.register(
            basePath +
            VEIL_ASSETS.serviceWorker,
            {
                scope:
                    basePath
            }
        );


    await navigator.serviceWorker.ready;


    const wispUrl =
        normalizeWispUrl(
            localStorage.getItem(
                "proxServer"
            ) ||
            DEFAULT_WISP
        );


    const servers =
        getAllWispServers();


    const autoswitch =
        localStorage.getItem(
            "wispAutoswitch"
        ) !== "false";


    const config = {

        type:
            "config",

        wispurl:
            wispUrl,

        servers,

        autoswitch
    };


    const sendConfig =
        () => {

            const worker =
                registration.active ||
                navigator.serviceWorker.controller;


            if (!worker) {
                return;
            }


            worker.postMessage(
                config
            );
        };


    sendConfig();

    setTimeout(
        sendConfig,
        500
    );

    setTimeout(
        sendConfig,
        1500
    );


    navigator.serviceWorker
        .addEventListener(
            "message",
            event => {

                const data =
                    event.data;


                if (!data) {
                    return;
                }


                if (
                    data.type ===
                    "wispChanged"
                ) {

                    if (
                        data.url
                    ) {

                        localStorage.setItem(
                            "proxServer",
                            normalizeWispUrl(
                                data.url
                            )
                        );
                    }


                    notify(
                        "info",
                        "Server Changed",
                        `Veil switched to ${
                            data.name ||
                            "another server"
                        }`
                    );


                } else if (
                    data.type ===
                    "wispError"
                ) {

                    console.error(
                        "Veil Wisp error:",
                        data
                    );


                    notify(
                        "error",
                        "Proxy Error",
                        data.message ||
                        "The selected Wisp server failed."
                    );
                }
            }
        );


    await registration.update();


    return registration;
}


// =====================================================
// MAIN INITIALIZATION
// =====================================================

document.addEventListener(
    "DOMContentLoaded",
    async () => {

        try {

            console.log(
                "Veil: starting..."
            );


            // Remove any old Wisp selection.
            initializeWispStorage();


            // Try the configured servers.
            await initializeWithBestServer();


            // Initialize local Scramjet.
            await getSharedScramjet();


            // Initialize local Epoxy + BareMux.
            await getSharedConnection();


            // Register local Veil service worker.
            await initializeServiceWorker();


            // Build browser UI.
            await initializeBrowser();


            console.log(
                "Veil: browser initialized."
            );


        } catch (error) {

            console.error(
                "Veil initialization error:",
                error
            );


            const root =
                document.getElementById(
                    "app"
                );


            if (root) {

                root.innerHTML = `
                    <div
                        style="
                            width:100%;
                            height:100%;
                            display:flex;
                            align-items:center;
                            justify-content:center;
                            background:#101010;
                            color:#fff;
                            font-family:Inter,system-ui,sans-serif;
                            padding:30px;
                            text-align:center;
                        "
                    >

                        <div>

                            <h1
                                style="
                                    margin-bottom:10px;
                                "
                            >
                                Veil failed to start
                            </h1>

                            <p
                                style="
                                    color:#888;
                                    max-width:600px;
                                "
                            >
                                ${
                                    escapeHtml(
                                        error?.message ||
                                        String(error)
                                    )
                                }
                            </p>

                        </div>

                    </div>
                `;
            }
        }
    }
);