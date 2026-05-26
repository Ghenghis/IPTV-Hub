// scripts/version.js
import { log } from "@/scripts/lib/log.js"
import { getVersion, getName } from '@tauri-apps/api/app'

export async function injectVersion() {
    const target = document.getElementById('app-version')
    const metaVersion = document.querySelector('meta[name="x-app-version"]')?.getAttribute("content")
    const isTauri = typeof window !== "undefined" && (!!window.__TAURI_INTERNALS__ || !!window.__TAURI__)
    if (!isTauri) {
        if (target && metaVersion) target.textContent = `Extreme InfiniTV v${metaVersion}`
        return
    }
    try {
        const version = await getVersion()
        const name = await getName()
        if (target) target.textContent = `${name} v${version}`
    } catch (e) {
        if (target && metaVersion) target.textContent = `Extreme InfiniTV v${metaVersion}`
        log.warn('Could not get app version:', e)
    }
}
