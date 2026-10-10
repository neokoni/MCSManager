/**
 * Rewrites formidable v2's dynamic plugin require so webpack can bundle it.
 *
 * formidable v2 (the copy nested inside koa-body) loads its built-in plugins
 * with `require(path.join(__dirname, 'plugins', `${name}.js`))`. Webpack cannot
 * statically evaluate that expression, so in single-file (BUNDLE=1) builds it
 * emits an empty context module that throws MODULE_NOT_FOUND at runtime, e.g.
 * `Cannot find module .../plugins/octetstream.js`, breaking file uploads.
 *
 * This loader rewrites that single call into the functionally equivalent
 * `require('./plugins/' + name + '.js')`, which webpack CAN analyze: it then
 * bundles every plugin file in the plugins/ directory into app.js.
 */
module.exports = function (source) {
  if (!/require\(\s*path\.join\(\s*__dirname/.test(source)) {
    return source;
  }

  const DYNAMIC_PLUGIN_REQUIRE =
    /require\(\s*path\.join\(\s*__dirname\s*,\s*['"]plugins['"]\s*,\s*`\$\{plgName\}\.js`\s*\)\s*\)/g;
  const STATIC_PLUGIN_REQUIRE = "require('./plugins/' + plgName + '.js')";
  const replaced = source.replace(DYNAMIC_PLUGIN_REQUIRE, STATIC_PLUGIN_REQUIRE);

  if (replaced === source) {
    this.emitWarning(
      new Error(
        "formidable dynamic plugin require was not matched; " +
          "verify the formidable version under node_modules."
      )
    );
  }
  return replaced;
};
