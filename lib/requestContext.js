const { AsyncLocalStorage } = require("async_hooks");

const als = new AsyncLocalStorage();

/**
 * Run `fn` with a request context available to any code called
 * (directly or indirectly, including across awaits) during its
 * execution. Used so shared helpers like generateAI() or
 * fetchSerpResults() can attribute usage to a user/feature without
 * every one of their ~15 call sites having to pass that in.
 */
function runWithContext(context, fn) {
    return als.run(context || {}, fn);
}

function getContext() {
    return als.getStore() || {};
}

function currentUserId() {
    return getContext().userId || null;
}

function currentFeature() {
    return getContext().feature || null;
}

module.exports = { runWithContext, getContext, currentUserId, currentFeature };
