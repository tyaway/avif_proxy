"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;
Cu.import("resource://gre/modules/Services.jsm");

function unwrap(o) { return o && o.wrappedJSObject || o; }

// There's no perfect proxy.
// (*) wp.com can't decode https://linkmauve.fr/files/railgun.avif (from
// https://github.com/Kagami/avif.js/issues/8). Most likely, wp.com is blocked
// by the server.
// (*) weserv.nl (wsrv.nl) can't decode animated images. wp.com at least returns
// one frame. See https://colinbendell.github.io/webperf/animated-gif-decode/avif.html
const g_settings = {
	enabled: true,
	fallback_proxies: null,
	proxies: null,
	proxy_idx: 0,
	strip_protocol: false,
	urlencode: true,
};

const g_pref_branch = "extensions.avif_proxy.";


const g_http_observer = {
	topics: ["http-on-examine-response", "http-on-examine-cached-response", "http-on-examine-merged-response"],
	registered: false,

	QueryInterface: function(aIID)
	{
		if (aIID.equals(Ci.nsIObserver) || aIID.equals(Ci.nsISupports))
		{
			return this;
		}
		throw Cr.NS_NOINTERFACE;
	},

	observe: function(subject, topic, data)
	{
		void(data);

		if ( ! this.topics.includes(topic)) { return; }

		const channel = subject;
		if ( ! Components.isSuccessCode(channel.status))
		{
			return;
		}
		channel.QueryInterface(Ci.nsIHttpChannel);

		const bypass_header = "x-extensions-avif_proxy-bypass";
		try
		{
			if (channel.getRequestHeader(bypass_header))
			{
				return;
			}
		}
		catch(x){void(x);}
		try
		{
			if (channel.getResponseHeader(bypass_header))
			{
				return;
			}
		}
		catch(x){void(x);}

		let ctx;
		const context_property = "extensions.avif_proxy.context";
		if (channel instanceof Ci.nsIPropertyBag && channel instanceof Ci.nsIWritablePropertyBag)
		{
			try
			{
				const bypass_property = "extensions.avif_proxy.bypass";
				if (channel.getProperty(bypass_property))
				{
					channel.deleteProperty(bypass_property);
					return;
				}
			}
			catch(x){void(x);}
			try { ctx = channel.getProperty(context_property); }catch(x){void(x);}
			ctx = unwrap(ctx);
		}
		else
		{
			Cu.reportError("ERROR: channel is not a property bag: " + channel.URI.spec);
		}

		const should_process = should_process_channel(channel);
		if ((ctx && ctx.fallback_done) || ( ! ctx && ! should_process))
		{
			return;
		}


		if ( ! ctx)
		{
			ctx = {fallback_proxy_idx: -1, fallback_done: false, url: channel.URI.spec};
			channel.setProperty(context_property, ctx);

			// When a redirect happens, the channel is swapped, so our context
			// property gets lost. So we must listen for redirects and copy our
			// context property to the new channel.
			// Replacing existing (non-null) |channel.notificationCallbacks|
			// on an XHR breaks its loading even if we call the previous
			// callback: the request finishes, but the result XHR fields
			// aren't set, e.g. responseURL="", status=0, responseText="".
			// Replacing |channel.loadGroup.notificationCallbacks| seems
			// to work fine even if we don't call the previous callback
			// or even if we don't set the new channel callbacks to us
			// at all (|newChannel.loadGroup.notificationCallbacks|
			// in asyncOnChannelRedirect()). Our callbacks won't be called,
			// but somehow our context property on the channel will be
			// preserved.
			// The above works for document loads (an image in a web page
			// or a standalone image) and XHR. It doesn't work for Image,
			// i.e. new Image().src = "...", because we don't get called.
			// In case of Image, |channel.loadGroup.notificationCallbacks|
			// is |null|, and |channel.notificationCallbacks| is not |null|.
			// This works for both:
			// 1) If |channel.loadGroup.notificationCallbacks| is not |null|,
			// set it.
			// 2) Otherwise set |channel.notificationCallbacks|.
			// I don't know if this is the right way to to this.
			const notification_callbacks = {
				// BEGIN nsIInterfaceRequestor methods.
				getInterface: function(uuid)
				{
					if (uuid.equals(Ci.nsIInterfaceRequestor) || uuid.equals(Ci.nsIChannelEventSink))
					{
						return this;
					}
					throw Cr.NS_ERROR_NO_INTERFACE;
				},
				// END nsIInterfaceRequestor methods.


				// BEGIN nsIChannelEventSink methods.
				asyncOnChannelRedirect: function(oldChannel, newChannel, flags, callback)
				{
					try
					{
						oldChannel.QueryInterface(Ci.nsIWritablePropertyBag).deleteProperty(context_property);
					}
					catch(x){void(x);}
					try
					{
						newChannel.QueryInterface(Ci.nsIWritablePropertyBag).setProperty(context_property, ctx);
					}
					catch(x)
					{
						Cu.reportError("ERROR: failed to preserve ctx: " + (x.message || x) + "\n" + x.stack);
					}
					if (callback != null && ("onRedirectVerifyCallback" in callback))
					{
						callback.onRedirectVerifyCallback(Cr.NS_OK);
					}
				},

				onChannelRedirect: function(oldChannel, newChannel, flags)
				{
					this.asyncOnChannelRedirect(oldChannel, newChannel, flags, null);
				},
				// END nsIChannelEventSink methods.
			};
			if (channel.loadGroup.notificationCallbacks)
			{
				channel.loadGroup.notificationCallbacks = notification_callbacks;
			}
			else
			{
				channel.notificationCallbacks = notification_callbacks;
			}
		}


		let proxies = g_settings.proxies;
		if (ctx.fallback_proxy_idx === -1)
		{
			if (Math.floor(channel.responseStatus / 100) === 2)
			{
				if ( ! should_process)
				{
					proxies = null;
				}
			}
			else
			{
				ctx.fallback_proxy_idx = 0;
				// 400, 5xx = switch to fallback URLs.
				ctx.fallback_done |= channel.responseStatus !== 400
					&& Math.floor(channel.responseStatus / 100) !== 5;
			}
		}
		if (ctx.fallback_proxy_idx !== -1)
		{
			ctx.fallback_done |= Math.floor(channel.responseStatus / 100) === 2;
			if ( ! ctx.fallback_done && g_settings.fallback_proxies && ctx.fallback_proxy_idx < g_settings.fallback_proxies.length)
			{
				proxies = g_settings.fallback_proxies;
			}
			else
			{
				ctx.fallback_done = true;
				proxies = null;
			}
		}
		if ( ! proxies)
		{
			return;
		}


		let proxy;
		if (proxies === g_settings.proxies)
		{
			proxy = proxies[g_settings.proxy_idx];
			if (++g_settings.proxy_idx >= proxies.length)
			{
				g_settings.proxy_idx = 0;
			}
		}
		else
		{
			proxy = proxies[ctx.fallback_proxy_idx];
			if (++ctx.fallback_proxy_idx >= proxies.length)
			{
				ctx.fallback_done = true;
			}
		}
		let url = ctx.url;
		if (proxy.strip_protocol)
		{
			url = url.replace(/^\w+:\/\//, "");
		}
		if (proxy.urlencode)
		{
			url = encodeURIComponent(url);
		}
		url = proxy.url.replace(/%url%/g, url);

		channel.redirectTo(Services.io.newURI(url, null, null));
	},

	register: function()
	{
		if (this.registered) { return; }
		this.registered = true;
		const obs = this;
		this.topics.forEach(function(topic){Services.obs.addObserver(obs, topic, false);});
	},

	unregister: function()
	{
		if ( ! this.registered) { return; }
		this.registered = false;
		const obs = this;
		this.topics.forEach(function(topic){Services.obs.removeObserver(obs, topic);});
	},
};


function trim(s) { return s != null ? String(s).replace(/^\s+|\s+$/g, "") : s; }

function should_process_channel(channel)
{
	return g_settings.proxies
		&& Math.floor(channel.responseStatus / 100) === 2
		&& /^https?$/.test(channel.URI.scheme)
		&& ! is_proxy_url(channel.URI.spec)
		&& "image/avif" === get_mime_type_for_channel(channel);
}
function is_proxy_url(url)
{
	return (g_settings.proxies || []).concat(g_settings.fallback_proxies || [])
		.some(function(o){
			const purl = (typeof(o) === "string" ? o : o.url).replace(/%url%.*$/, "");
			return url.startsWith(purl);
		});
}
function get_mime_type_for_channel(channel)
{
	let ct;
	if ( ! ct)
	{
		try{ ct = trim(channel.contentType); }catch(x){void(x);}
	}
	if ( ! ct)
	{
		try{ ct = trim(channel.getResponseHeader("content-type")); }catch(x){void(x);}
	}
	if ( ! ct)
	{
		ct = get_mime_type_by_extension(get_file_extension(channel.URI.spec));
	}
	if (ct)
	{
		ct = trim(ct.toLowerCase().replace(/;.*$/, ""));
	}
	return ct;
}
function get_mime_type_by_extension(ext)
{
	if ( ! (ext = trim(ext))) { return null; }
	switch (ext.toLowerCase())
	{
		case "avif":
			return "image/avif";
	}
	return null;
}
function get_file_extension(url)
{
	return (url.replace(/[?#].*$/, "").split(/\/+/).pop().match(/\.([^.]+)$/) || [])[1] || "";
}



const g_pref_observer = {
	pref_branch: null,

	observe: function(subject, topic, data)
	{
		void(subject);
		if (topic !== "nsPref:changed") { return; }
		switch (data)
		{
			case "enabled":
				g_settings.enabled = get_bool_pref(data);
				g_settings.enabled ? g_http_observer.register() : g_http_observer.unregister();
				break;
			case "strip_protocol":
				g_settings.strip_protocol = get_bool_pref(data);
				read_proxies();
				break;
			case "urlencode":
				g_settings.urlencode = get_bool_pref(data);
				read_proxies();
				break;
			default:
				if (data === "proxy_url" || data === "fallback_proxy_url" || data.startsWith("proxy_url."))
				{
					read_proxies();
				}
				break;
		}
	},

	register: function()
	{
		this.pref_branch = Services.prefs.getBranch(g_pref_branch);
		this.pref_branch.addObserver("", this, false);
	},

	unregister: function()
	{
		this.pref_branch.removeObserver("", this);
		this.pref_branch = null;
	},
};


function read_proxy(pref_name)
{
	let rc = null;

	if (pref_exists(pref_name))
	{
		const values = [];
		trim(get_char_pref(pref_name)).split(/\s*,\s*/).forEach(function(uname){
			if (pref_exists(uname = "proxy_url." + uname))
			{
				const str = trim(get_char_pref(uname));
				try
				{
					const data = str.startsWith("{") ? JSON.parse(str) : {url: str};
					if ( ! data.url) { return; }
					["strip_protocol", "urlencode"].forEach(function(prop){
						if ( ! data.hasOwnProperty(prop))
						{
							data[prop] = g_settings[prop];
						}
					});
					values.push(data);
				}
				catch (x)
				{
					Cu.reportError("ERROR: Invalid proxy '" + uname + "': invalid JSON: " + (x && x.message || x));
				}
			}
		});
		if (values.length)
		{
			rc = values;
		}
	}

	return rc;
}

function read_proxies()
{
	g_settings.proxies = read_proxy("proxy_url"); g_settings.proxy_idx = 0;
	g_settings.fallback_proxies = read_proxy("fallback_proxy_url");
}


function pref_exists(name)
{
	return g_pref_observer.pref_branch.getPrefType(name) !== 0 /*PREF_INVALID*/;
}
function get_bool_pref(name)
{
	return g_pref_observer.pref_branch.getBoolPref(name);
}
function get_char_pref(name)
{
	return g_pref_observer.pref_branch.getCharPref(name);
}



// From prefloader.js
function loadDefaultPrefs(path, fileName)
{
	try
	{
		const baseURI = Services.io.newFileURI(path);
		const uri = path.isDirectory()
			? Services.io.newURI("defaults/preferences/" + fileName, null, baseURI).spec
			: "jar:" + baseURI.spec + "!/defaults/preferences/" + fileName;
		Services.scriptloader.loadSubScript(uri, {pref: pref});
	}
	catch (err)
	{
		Cu.reportError(err);
	}
}
function clearDefaultPrefs()
{
	const pb = Services.prefs.getDefaultBranch(g_pref_branch);
	pb.getChildList("").forEach(function(name){
		if ( ! pb.prefHasUserValue(name))
		{
			pb.deleteBranch(name);
		}
	});
}
function pref(name, value)
{
	try
	{
		const branch = Services.prefs.getDefaultBranch("");

		switch (typeof value)
		{
			case "boolean":
				branch.setBoolPref(name, value);
				break;

			case "number":
				branch.setIntPref(name, value);
				break;

			case "string":
			{
				const str = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
				str.data = value;
				branch.setComplexValue(name, Ci.nsISupportsString, str);
				break;
			}
		}
	}
	catch (e)
	{
		Cu.reportError("prefLoader.pref: can't set default pref value for: " + name + ": " + (e && e.message || e));
	}
}



// eslint-disable-next-line no-unused-vars
function startup(data, reason)
{
	void(data, reason);

	loadDefaultPrefs(data.installPath, "prefs.js");
	g_pref_observer.register();

	g_settings.enabled = get_bool_pref("enabled");
	g_settings.strip_protocol = get_bool_pref("strip_protocol");
	g_settings.urlencode = get_bool_pref("urlencode");
	read_proxies();

	if (g_settings.enabled)
	{
		g_http_observer.register();
	}
}

// eslint-disable-next-line no-unused-vars
function shutdown(data, reason)
{
	void(data, reason);

	if (reason === APP_SHUTDOWN) { return; }

	g_pref_observer.unregister();
	g_http_observer.unregister();
}

// eslint-disable-next-line no-unused-vars
function install(){}

// eslint-disable-next-line no-unused-vars
function uninstall(data, reason)
{
	void(data, reason);

	if (reason === ADDON_UNINSTALL)
	{
		clearDefaultPrefs();
	}
}
