(function () {
  if (window.__apiDebugInjected) return;
  window.__apiDebugInjected = true;

  function headersToObject(headers) {
    if (!headers) return {};
    if (headers instanceof Headers) {
      const obj = {};
      headers.forEach((v, k) => { obj[k] = v; });
      return obj;
    }
    if (Array.isArray(headers)) return Object.fromEntries(headers);
    return { ...headers };
  }

  function bodyToString(body) {
    if (body == null) return null;
    if (typeof body === 'string') return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof FormData) return '[FormData]';
    if (body instanceof Blob) return '[Blob]';
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return '[Binary]';
    return String(body);
  }

  function send(data) {
    chrome.runtime.sendMessage({ type: 'API_REQUEST', data }).catch(() => {});
  }

  // --- fetch intercept ---
  const originalFetch = window.fetch;
  window.fetch = async function (input, init = {}) {
    const startTime = Date.now();
    const url = input instanceof Request ? input.url : String(input);
    const method = (
      (init && init.method) ||
      (input instanceof Request && input.method) ||
      'GET'
    ).toUpperCase();
    const reqHeaders = headersToObject(
      (init && init.headers) || (input instanceof Request ? input.headers : null)
    );
    const reqBody = bodyToString(
      (init && init.body) || (input instanceof Request ? null : null)
    );

    let response;
    try {
      response = await originalFetch.apply(this, arguments);
    } catch (err) {
      send({
        url, method,
        requestHeaders: reqHeaders, requestBody: reqBody,
        status: 0, statusText: err.message,
        responseHeaders: {}, responseBody: null,
        duration: Date.now() - startTime, timestamp: startTime
      });
      throw err;
    }

    const duration = Date.now() - startTime;
    const resHeaders = headersToObject(response.headers);
    let resBody = null;
    try {
      resBody = await response.clone().text();
    } catch (_) {}

    send({
      url, method,
      requestHeaders: reqHeaders, requestBody: reqBody,
      status: response.status, statusText: response.statusText,
      responseHeaders: resHeaders, responseBody: resBody,
      duration, timestamp: startTime
    });

    return response;
  };

  // --- XHR intercept ---
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._dbg = { method: method.toUpperCase(), url: String(url), headers: {} };
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this._dbg) this._dbg.headers[name] = value;
    return origSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (!this._dbg) return origSend.apply(this, arguments);

    const dbg = this._dbg;
    dbg.startTime = Date.now();
    dbg.body = bodyToString(body);

    this.addEventListener('loadend', () => {
      const resHeaders = {};
      (this.getAllResponseHeaders() || '').trim().split(/[\r\n]+/).forEach(line => {
        const sep = line.indexOf(': ');
        if (sep > -1) resHeaders[line.slice(0, sep)] = line.slice(sep + 2);
      });
      send({
        url: dbg.url, method: dbg.method,
        requestHeaders: dbg.headers, requestBody: dbg.body,
        status: this.status, statusText: this.statusText,
        responseHeaders: resHeaders, responseBody: this.responseText || null,
        duration: Date.now() - dbg.startTime, timestamp: dbg.startTime
      });
    });

    return origSend.apply(this, arguments);
  };
})();
