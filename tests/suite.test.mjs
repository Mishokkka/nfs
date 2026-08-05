// Compatibility entrypoint for older development commands. The default npm
// test intentionally runs only the fast release gate; integration and soak
// profiles are explicit package scripts.
import "./fast-suite.test.mjs";
import "./integration-suite.test.mjs";
