(function () {
  if (window.__IMPALA_TARGET_BLANK_SHIM__) return;
  window.__IMPALA_TARGET_BLANK_SHIM__ = true;

  document.addEventListener(
    "click",
    function (event) {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      var target = event.target;
      if (!(target instanceof Element)) return;
      var anchor = target.closest("a[href]");
      if (
        !anchor ||
        String(anchor.target).toLowerCase() !== "_blank" ||
        anchor.hasAttribute("download") ||
        !anchor.href
      ) {
        return;
      }

      event.preventDefault();
      location.assign(
        "https://impala.invalid/open-new-tab?url=" +
          encodeURIComponent(anchor.href),
      );
    },
    true,
  );
})();
