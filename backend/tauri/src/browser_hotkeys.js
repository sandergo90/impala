(function () {
  if (window.__IMPALA_HOTKEY_SHIM__) return;
  window.__IMPALA_HOTKEY_SHIM__ = true;

  var ACTIONS = { r: "reload", l: "focus-address", w: "close-pane" };
  var MODIFIER_KEYS = { meta: true, control: true, alt: true, shift: true };
  // Chords with editing defaults are never taken from an editable target —
  // Cmd+Backspace must delete a line, not fire Delete Worktree in the shell.
  var EDITING_KEYS = {
    a: true,
    c: true,
    v: true,
    x: true,
    z: true,
    y: true,
    arrowleft: true,
    arrowright: true,
    arrowup: true,
    arrowdown: true,
    backspace: true,
    delete: true,
  };

  function isEditable(target) {
    if (!target) return false;
    if (target.isContentEditable) return true;
    var tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }

  window.addEventListener(
    "keydown",
    function (event) {
      // isTrusted keeps page scripts from firing shell shortcuts by
      // dispatching synthetic KeyboardEvents at this listener.
      if (!event.isTrusted || event.repeat) return;
      if (!(event.metaKey || event.ctrlKey)) return;
      var key = String(event.key).toLowerCase();
      if (MODIFIER_KEYS[key]) return;

      var action = ACTIONS[key];
      if (
        action &&
        event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        location.assign("https://impala.invalid/hotkey?action=" + action);
        return;
      }

      // Forward every other chord to the shell so app-wide shortcuts keep
      // working while the page has focus. No preventDefault: the page keeps
      // its own handling.
      if (EDITING_KEYS[key] && isEditable(event.target)) return;
      location.assign(
        "https://impala.invalid/hotkey?action=forward" +
          "&key=" +
          encodeURIComponent(event.key) +
          "&code=" +
          encodeURIComponent(event.code || "") +
          "&meta=" +
          (event.metaKey ? 1 : 0) +
          "&ctrl=" +
          (event.ctrlKey ? 1 : 0) +
          "&alt=" +
          (event.altKey ? 1 : 0) +
          "&shift=" +
          (event.shiftKey ? 1 : 0),
      );
    },
    true,
  );
})();
