document.documentElement.dataset.platform =
  /Mac/.test(navigator.platform) ? 'darwin' :
  /Win/.test(navigator.platform) ? 'win32' : 'linux';
