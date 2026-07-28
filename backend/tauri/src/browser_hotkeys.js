(function () {
  if (window.__IMPALA_HOTKEY_SHIM__) return;
  window.__IMPALA_HOTKEY_SHIM__ = true;

  var ACTIONS = { r: "reload", l: "focus-address", w: "close-pane" };

  window.addEventListener(
    "keydown",
    function (event) {
      if (!event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      if (event.repeat) return;
      var action = ACTIONS[String(event.key).toLowerCase()];
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      location.assign("https://impala.invalid/hotkey?action=" + action);
    },
    true,
  );
})();
