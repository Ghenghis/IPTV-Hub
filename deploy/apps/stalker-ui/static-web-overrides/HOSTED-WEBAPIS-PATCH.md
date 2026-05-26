# Hosted webapis stub patch

The upstream hosted `index.html` includes Samsung/Tizen's TV API script:

```html
<script src="$WEBAPIS/webapis/webapis.js"></script>
```

On nginx this path falls back to `index.html`, so browsers try to execute HTML
as JavaScript and throw `Unexpected token '<'`. For DaveTV hosted web builds,
replace that script path with:

```html
<script src="/webapis/webapis.js"></script>
```

Then copy `webapis/webapis.js` into the deployed app root. The stub only defines
no-op `window.webapis.avplay` and `window.tizen` objects; playback still uses
DaveTV provider-vault/browser APIs.
