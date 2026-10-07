/* Cookie consent + optional Google Analytics. DOM-only; not part of the MCP kernel. */
(function () {
    var STORAGE_KEY = 'millpcb-cookie-consent';
    var GA_ID = 'G-LBBZFT66R7';
    var GRANTED = 'granted';
    var DENIED = 'denied';

    function isFileProtocol() {
        try {
            return location.protocol === 'file:';
        } catch (e) {
            return true;
        }
    }

    function isEditorPage() {
        try {
            var path = location.pathname || '';
            if (path === '/' || path === '') return true;
            var file = path.split('/').pop();
            return file === 'index.html';
        } catch (e) {
            return false;
        }
    }

    function readChoice() {
        try {
            var v = localStorage.getItem(STORAGE_KEY);
            if (v === GRANTED || v === DENIED) return v;
            return null;
        } catch (e) {
            return null;
        }
    }

    function writeChoice(value) {
        try {
            localStorage.setItem(STORAGE_KEY, value);
            return localStorage.getItem(STORAGE_KEY) === value;
        } catch (e) {
            return false;
        }
    }

    function clearChoice() {
        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch (e) { /* ignore */ }
    }

    function hideBanner() {
        var el = document.getElementById('cookie-banner');
        if (el && el.parentNode) el.parentNode.removeChild(el);
    }

    function loadGtag() {
        if (isFileProtocol() || !isEditorPage()) return;
        if (window.__millpcbGtagLoaded) return;
        window.__millpcbGtagLoaded = true;
        try {
            window.dataLayer = window.dataLayer || [];
            window.gtag = function () { window.dataLayer.push(arguments); };
            window.gtag('js', new Date());
            window.gtag('config', GA_ID);
            var s = document.createElement('script');
            s.async = true;
            s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
            s.onerror = function () { /* editor remains usable */ };
            (document.head || document.documentElement).appendChild(s);
        } catch (e) { /* editor remains usable */ }
    }

    function applyChoice(choice) {
        hideBanner();
        if (choice === GRANTED) loadGtag();
        else if (choice === DENIED && window.__millpcbGtagLoaded) {
            try { location.reload(); } catch (e) { /* editor remains usable */ }
        }
    }

    function showBanner() {
        if (!document.body) return;
        if (document.getElementById('cookie-banner')) return;
        var bar = document.createElement('div');
        bar.id = 'cookie-banner';
        bar.setAttribute('role', 'dialog');
        bar.setAttribute('aria-label', 'Cookie consent');

        var copy = document.createElement('p');
        copy.className = 'cookie-banner-copy';
        copy.appendChild(document.createTextNode('Optional analytics cookies. The editor works without them. '));
        var more = document.createElement('a');
        more.href = 'legal.html#cookies';
        more.textContent = 'Details';
        copy.appendChild(more);

        var actions = document.createElement('div');
        actions.className = 'cookie-banner-actions';

        var accept = document.createElement('button');
        accept.type = 'button';
        accept.className = 'cookie-banner-btn';
        accept.textContent = 'Accept';
        accept.addEventListener('click', function () {
            if (!writeChoice(GRANTED)) return;
            applyChoice(GRANTED);
        });

        var reject = document.createElement('button');
        reject.type = 'button';
        reject.className = 'cookie-banner-btn';
        reject.textContent = 'Reject';
        reject.addEventListener('click', function () {
            if (!writeChoice(DENIED)) return;
            applyChoice(DENIED);
        });

        actions.appendChild(accept);
        actions.appendChild(reject);
        bar.appendChild(copy);
        bar.appendChild(actions);
        document.body.appendChild(bar);
    }

    function bindChangeCookies() {
        var link = document.getElementById('change-cookies');
        if (!link) return;
        link.addEventListener('click', function (e) {
            e.preventDefault();
            clearChoice();
            if (!isFileProtocol()) showBanner();
        });
    }

    function start() {
        bindChangeCookies();
        var choice = readChoice();
        if (choice === GRANTED) {
            applyChoice(GRANTED);
            return;
        }
        if (choice === DENIED) {
            hideBanner();
            return;
        }
        if (!isFileProtocol()) showBanner();
    }

    if (typeof document === 'undefined') return;
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
