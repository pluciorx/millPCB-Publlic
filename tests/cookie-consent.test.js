'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'cookie-consent.js'), 'utf8');

function makeStorage() {
    const map = new Map();
    return {
        getItem(k) { return map.has(k) ? map.get(k) : null; },
        setItem(k, v) { map.set(k, String(v)); },
        removeItem(k) { map.delete(k); },
        _map: map
    };
}

function runScene(opts) {
    const scripts = [];
    const storage = opts.storage || makeStorage();
    const bodyChildren = [];
    const listeners = {};
    let reloaded = false;

    const bannerEl = { id: 'cookie-banner', parentNode: null };
    let bannerMounted = false;

    const changeLink = {
        id: 'change-cookies',
        addEventListener(type, fn) { listeners.change = fn; }
    };

    function createEl(tag) {
        const el = {
            tagName: tag.toUpperCase(),
            children: [],
            attributes: {},
            className: '',
            textContent: '',
            type: '',
            href: '',
            async: false,
            src: '',
            onerror: null,
            addEventListener(type, fn) {
                if (type === 'click') el._click = fn;
            },
            setAttribute(k, v) { el.attributes[k] = v; },
            appendChild(c) { el.children.push(c); }
        };
        if (tag === 'div' && !el.id) {
            // first div from showBanner is the banner
        }
        return el;
    }

    const document = {
        readyState: 'complete',
        head: { appendChild(n) { scripts.push(n); } },
        documentElement: { appendChild(n) { scripts.push(n); } },
        body: {
            appendChild(n) {
                if (n.id === 'cookie-banner') {
                    bannerMounted = true;
                    n.parentNode = document.body;
                    bannerEl.parentNode = document.body;
                }
                bodyChildren.push(n);
            }
        },
        getElementById(id) {
            if (id === 'cookie-banner') return bannerMounted ? Object.assign(bannerEl, bodyChildren.find(c => c.id === 'cookie-banner') || bannerEl) : null;
            if (id === 'change-cookies') return opts.withChangeLink ? changeLink : null;
            return null;
        },
        createElement(tag) {
            const el = createEl(tag);
            const origSet = Object.getOwnPropertyDescriptor(el, 'id');
            Object.defineProperty(el, 'id', {
                get() { return this._id || ''; },
                set(v) {
                    this._id = v;
                    if (v === 'cookie-banner') el.parentNode = null;
                },
                configurable: true
            });
            return el;
        },
        createTextNode(t) { return { nodeType: 3, text: t }; },
        addEventListener() {}
    };

    // Fix getElementById after mount
    document.getElementById = function (id) {
        if (id === 'change-cookies') return opts.withChangeLink ? changeLink : null;
        if (id === 'cookie-banner') {
            const found = bodyChildren.find(c => c.id === 'cookie-banner');
            if (!found || !bannerMounted) return null;
            found.parentNode = {
                removeChild(n) {
                    bannerMounted = false;
                    const i = bodyChildren.indexOf(n);
                    if (i >= 0) bodyChildren.splice(i, 1);
                }
            };
            return found;
        }
        return null;
    };

    const windowObj = {
        dataLayer: undefined,
        gtag: undefined,
        __millpcbGtagLoaded: undefined
    };

    const ctx = {
        window: windowObj,
        document,
        location: {
            protocol: opts.protocol || 'https:',
            pathname: opts.pathname || '/index.html',
            reload() { reloaded = true; }
        },
        localStorage: storage,
        Date,
        console
    };
    ctx.window.window = windowObj;
    ctx.global = ctx;

    vm.runInNewContext(SRC, ctx, { filename: 'cookie-consent.js' });

    return {
        storage,
        scripts,
        bodyChildren,
        bannerMounted: () => bannerMounted && bodyChildren.some(c => c.id === 'cookie-banner'),
        click(label) {
            const bar = bodyChildren.find(c => c.id === 'cookie-banner');
            assert(bar, 'banner missing');
            const actions = bar.children.find(c => c.className === 'cookie-banner-actions');
            const btn = actions.children.find(c => c.textContent === label);
            btn._click();
        },
        changeCookies() { listeners.change({ preventDefault() {} }); },
        gtagLoaded: () => scripts.some(s => s.src && String(s.src).indexOf('gtag/js?id=G-LBBZFT66R7') !== -1),
        reloaded: () => reloaded
    };
}

let failed = 0;
function test(name, fn) {
    try {
        fn();
        console.log('ok - ' + name);
    } catch (e) {
        failed++;
        console.log('not ok - ' + name);
        console.log('  ' + e.message);
        if (e.stack) console.log(e.stack.split('\n').slice(0, 4).join('\n'));
    }
}

test('index.html has no eager gtag and loads consent helper', function () {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    assert.strictEqual(html.indexOf('googletagmanager.com') === -1, true);
    assert.ok(html.indexOf('js/cookie-consent.js') !== -1);
});

test('legal.html wires change-cookies and consent helper', function () {
    const html = fs.readFileSync(path.join(__dirname, '..', 'legal.html'), 'utf8');
    assert.ok(html.indexOf('id="change-cookies"') !== -1);
    assert.ok(html.indexOf('js/cookie-consent.js') !== -1);
});

test('first https visit: banner, no gtag', function () {
    const s = runScene({ protocol: 'https:', pathname: '/index.html' });
    assert.strictEqual(s.bannerMounted(), true);
    assert.strictEqual(s.gtagLoaded(), false);
});

test('Accept: store granted, load gtag, hide banner', function () {
    const s = runScene({ protocol: 'https:', pathname: '/index.html' });
    s.click('Accept');
    assert.strictEqual(s.storage.getItem('millpcb-cookie-consent'), 'granted');
    assert.strictEqual(s.bannerMounted(), false);
    assert.strictEqual(s.gtagLoaded(), true);
});

test('Reject: store denied, never load gtag, hide banner', function () {
    const s = runScene({ protocol: 'https:', pathname: '/index.html' });
    s.click('Reject');
    assert.strictEqual(s.storage.getItem('millpcb-cookie-consent'), 'denied');
    assert.strictEqual(s.bannerMounted(), false);
    assert.strictEqual(s.gtagLoaded(), false);
});

test('return granted: no banner, gtag on editor', function () {
    const storage = makeStorage();
    storage.setItem('millpcb-cookie-consent', 'granted');
    const s = runScene({ protocol: 'https:', pathname: '/index.html', storage });
    assert.strictEqual(s.bannerMounted(), false);
    assert.strictEqual(s.gtagLoaded(), true);
});

test('return denied: no banner, no gtag', function () {
    const storage = makeStorage();
    storage.setItem('millpcb-cookie-consent', 'denied');
    const s = runScene({ protocol: 'https:', pathname: '/index.html', storage });
    assert.strictEqual(s.bannerMounted(), false);
    assert.strictEqual(s.gtagLoaded(), false);
});

test('corrupt value treated as no choice', function () {
    const storage = makeStorage();
    storage.setItem('millpcb-cookie-consent', 'maybe');
    const s = runScene({ protocol: 'https:', pathname: '/index.html', storage });
    assert.strictEqual(s.bannerMounted(), true);
    assert.strictEqual(s.gtagLoaded(), false);
});

test('granted on help/legal: no gtag (editor only)', function () {
    const storage = makeStorage();
    storage.setItem('millpcb-cookie-consent', 'granted');
    const s = runScene({ protocol: 'https:', pathname: '/legal.html', storage });
    assert.strictEqual(s.gtagLoaded(), false);
    assert.strictEqual(s.bannerMounted(), false);
});

test('file://: no google, no banner, no throw', function () {
    const s = runScene({ protocol: 'file:', pathname: '/C:/Git/millPCB/index.html' });
    assert.strictEqual(s.bannerMounted(), false);
    assert.strictEqual(s.gtagLoaded(), false);
});

test('Change cookies: clear stored choice and show banner', function () {
    const storage = makeStorage();
    storage.setItem('millpcb-cookie-consent', 'denied');
    const s = runScene({ protocol: 'https:', pathname: '/legal.html', storage, withChangeLink: true });
    assert.strictEqual(s.bannerMounted(), false);
    s.changeCookies();
    assert.strictEqual(s.storage.getItem('millpcb-cookie-consent'), null);
    assert.strictEqual(s.bannerMounted(), true);
    assert.strictEqual(s.gtagLoaded(), false);
});

test('granted on pathname / loads gtag', function () {
    const storage = makeStorage();
    storage.setItem('millpcb-cookie-consent', 'granted');
    const s = runScene({ protocol: 'https:', pathname: '/', storage });
    assert.strictEqual(s.gtagLoaded(), true);
});

test('granted on /help.html does not load gtag', function () {
    const storage = makeStorage();
    storage.setItem('millpcb-cookie-consent', 'granted');
    const s = runScene({ protocol: 'https:', pathname: '/help.html', storage });
    assert.strictEqual(s.gtagLoaded(), false);
});

test('file:// + granted: no gtag', function () {
    const storage = makeStorage();
    storage.setItem('millpcb-cookie-consent', 'granted');
    const s = runScene({ protocol: 'file:', pathname: '/C:/Git/millPCB/index.html', storage });
    assert.strictEqual(s.gtagLoaded(), false);
});

test('Accept then Change cookies then Reject reloads to stop gtag', function () {
    const s = runScene({ protocol: 'https:', pathname: '/index.html', withChangeLink: true });
    s.click('Accept');
    assert.strictEqual(s.gtagLoaded(), true);
    s.changeCookies();
    assert.strictEqual(s.storage.getItem('millpcb-cookie-consent'), null);
    s.click('Reject');
    assert.strictEqual(s.storage.getItem('millpcb-cookie-consent'), 'denied');
    assert.strictEqual(s.reloaded(), true);
});

test('Accept does not load gtag if localStorage write fails', function () {
    const storage = {
        getItem() { return null; },
        setItem() { throw new Error('quota'); },
        removeItem() {}
    };
    const s = runScene({ protocol: 'https:', pathname: '/index.html', storage });
    s.click('Accept');
    assert.strictEqual(s.gtagLoaded(), false);
    assert.strictEqual(s.bannerMounted(), true);
});

test('granted on /js/ is not the editor', function () {
    const storage = makeStorage();
    storage.setItem('millpcb-cookie-consent', 'granted');
    const s = runScene({ protocol: 'https:', pathname: '/js/', storage });
    assert.strictEqual(s.gtagLoaded(), false);
});

if (failed) {
    console.error(failed + ' failed');
    process.exit(1);
}
console.log('All cookie-consent tests passed.');
