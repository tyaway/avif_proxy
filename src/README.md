AVIF image proxy extension for SeaMonkey.

Loads AVIF images via a proxy that converts them to a supported format like JPEG.


---


## Settings.

The settings are in `about:config` under the branch `extensions.avif_proxy`.

* **`extensions.avif_proxy.enabled`** - boolean. Set to false to disable the extension.

* **`extensions.avif_proxy.proxy_url`** - string. A comma-separated list of main proxy names to try in a round-robin manner. See **Proxy entries** below for proxy entries format.

* **`extensions.avif_proxy.fallback_proxy_url`** - string. A comma-separated list of fallback proxy names to try when a main proxy from the `proxy_url` list fails. All fallback proxies in the list will be tried in the exact order until the request succeeds or there's no more fallback proxies left to try.

* **`extensions.avif_proxy.strip_protocol`** - boolean. Set to true to strip the protocol (scheme) and `://` from the URL: `https://www.example.com/path/to/file.avif` -> `www.example.com/path/to/file.avif`.

* **`extensions.avif_proxy.urlencode`** - boolean. Set to true to encode the URL with encodeURIComponent: `www.example.com/path/to/file.avif` -> `www.example.com%2Fpath%2Fto%2Ffile.avif`.



### Proxy entries.

Proxy entries are specified under `extensions.avif_proxy.proxy_url.XXX` where `XXX` is the name of the entry. This name is used in `extensions.avif_proxy.proxy_url` and `extensions.avif_proxy.fallback_proxy_url` to refer to this entry.

The value must be a string containing either a proxy URL or a JSON object with the following structure:
* **`url`** - string. The proxy URL. The URL must contain a placeholder `%url%` that will be replaced with the target image URL after it's been processed according to the `strip_protocol` and `urlencode` settings.

* **`strip_protocol`** - boolean, optional. Overrides the global `strip_protocol` (see **Settings** above).

* **`urlencode`** - boolean, optional. Overrides the global `urlencode` (see **Settings** above).

An example object:
```json
{
  "url": "https://i0.wp.com/%url%",
  "strip_protocol": true,
  "urlencode": false
}
```

See file `defaults/preferences/prefs.js` for examples.


---


## Bypass mode.
To make the extension pass your request through unmodified, use one of the following:

1. **From content code (non-privileged code: web page, userscript).**

	Set an HTTP request header `x-extensions-avif_proxy-bypass` to any non-empty value.
	```js
	// XMLHttpRequest
	var xhr = new XMLHttpRequest();
	xhr.open(...);
	xhr.setRequestHeader("x-extensions-avif_proxy-bypass", "1");

	// fetch
	fetch(..., {
	    headers: {
	        "x-extensions-avif_proxy-bypass": "1"
	    }
	});
	```

2. **From privileged (chrome) code.**

	The HTTP request header method still works. As an alternative to it, you can use `nsIWritablePropertyBag` to set a channel property `extensions.avif_proxy.bypass` to any truthy value, e.g. a non-empty string or a non-zero number.
	```js
	var xhr = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"].createInstance(Ci.nsIXMLHttpRequest);
	xhr.open(...);
	var channel = xhr.channel;
	channel.QueryInterface(Ci.nsIWritablePropertyBag);
	channel.setProperty("extensions.avif_proxy.bypass", true);
	xhr.send();
	```
