import { Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild } from "@angular/core";
import { DownloadService } from "./download.service";
import Hls from "hls.js";
import { ProviderPlayback, ProviderVaultService } from "./provider-vault.service";
import { Subscription } from "rxjs";

@Component({
  selector: "app-root",
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
})
export class AppComponent implements OnInit, OnDestroy {
  title = "open-tv";
  currentPlayback?: ProviderPlayback;
  private hls?: Hls;
  private playbackSub?: Subscription;
  @ViewChild("vaultVideo") vaultVideo?: ElementRef<HTMLVideoElement>;

  constructor(
    private download: DownloadService,
    private providerVault: ProviderVaultService,
  ) {}

  ngOnInit() {
    this.playbackSub = this.providerVault.playback.subscribe((playback) => {
      this.currentPlayback = playback;
      setTimeout(() => this.attachPlayback(), 0);
    });
  }

  @HostListener("document:contextmenu", ["$event"])
  onRightClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (this.isInsideMenuTrigger(target)) {
      return;
    }
    event.preventDefault();
  }

  private isInsideMenuTrigger(element: HTMLElement): boolean {
    return !!element.closest("[mat-menu-trigger-for], [matMenuTriggerFor]");
  }

  showDownloadManager() {
    return this.download.Downloads.size > 0;
  }

  closePlayback() {
    this.destroyHls();
    const video = this.vaultVideo?.nativeElement;
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    this.currentPlayback = undefined;
  }

  ngOnDestroy() {
    this.playbackSub?.unsubscribe();
    this.destroyHls();
  }

  private attachPlayback() {
    const video = this.vaultVideo?.nativeElement;
    const playback = this.currentPlayback;
    if (!video || !playback) return;
    this.destroyHls();
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;

    if (playback.url.includes(".m3u8") || playback.url.includes("ext=m3u8")) {
      if (Hls.isSupported()) {
        this.hls = new Hls({
          enableWorker: true,
          maxBufferLength: 180,
          maxMaxBufferLength: 600,
          backBufferLength: 90,
          liveDurationInfinity: true,
          liveSyncDurationCount: 6,
          liveMaxLatencyDurationCount: 20,
        });
        this.hls.loadSource(playback.url);
        this.hls.attachMedia(video);
        this.hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => undefined));
        return;
      }
    }

    video.src = playback.url;
    video.play().catch(() => undefined);
  }

  private destroyHls() {
    this.hls?.destroy();
    this.hls = undefined;
  }
}
