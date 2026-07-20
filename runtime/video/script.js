(() => {
  const video = document.getElementById("video");
  const stage = document.getElementById("stage");
  const overlay = document.getElementById("overlay");
  const bigPlay = document.getElementById("bigPlay");
  const playPause = document.getElementById("playPause");
  const playIcon = document.getElementById("playIcon");
  const muteBtn = document.getElementById("mute");
  const muteIcon = document.getElementById("muteIcon");
  const fullscreenBtn = document.getElementById("fullscreen");
  const seek = document.getElementById("seek");
  const currentTimeEl = document.getElementById("currentTime");
  const durationEl = document.getElementById("duration");
  const statusEl = document.getElementById("status");
  const openFileBtn = document.getElementById("openFile");
  const fileInput = document.getElementById("fileInput");
  const titleEl = document.getElementById("title");

  if (
    !video ||
    !stage ||
    !overlay ||
    !bigPlay ||
    !playPause ||
    !playIcon ||
    !muteBtn ||
    !muteIcon ||
    !fullscreenBtn ||
    !seek ||
    !currentTimeEl ||
    !durationEl ||
    !statusEl ||
    !openFileBtn ||
    !fileInput ||
    !titleEl
  ) {
    return;
  }

  let mediaReady = false;
  let isSeeking = false;
  let hideControlsTimer = 0;
  let objectUrl = null;
  let dragDepth = 0;

  const missingMessage =
    "Open a local video, drop one here, or add media/demo.mp4.";

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const total = Math.floor(seconds);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function setStatus(message, kind = "") {
    statusEl.textContent = message;
    statusEl.classList.remove("is-error", "is-ready");
    if (kind) statusEl.classList.add(kind);
  }

  function setPlayingUi(playing) {
    playIcon.textContent = playing ? "❚❚" : "▶";
    playPause.setAttribute("aria-label", playing ? "Pause" : "Play");
    bigPlay.hidden = playing || !mediaReady;
    stage.classList.toggle("is-paused", !playing);
  }

  function setMuteUi(muted) {
    muteIcon.textContent = muted || video.volume === 0 ? "🔇" : "🔊";
    muteBtn.setAttribute("aria-label", muted ? "Unmute" : "Mute");
  }

  function updateProgress() {
    if (isSeeking) return;
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      seek.value = "0";
      currentTimeEl.textContent = "0:00";
      durationEl.textContent = "0:00";
      return;
    }
    const pct = (video.currentTime / duration) * 100;
    seek.value = String(pct);
    currentTimeEl.textContent = formatTime(video.currentTime);
    durationEl.textContent = formatTime(duration);
  }

  function revokeObjectUrl() {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
  }

  function clearSourceElements() {
    while (video.firstChild) {
      video.removeChild(video.firstChild);
    }
  }

  function loadFile(file) {
    if (!file) return;

    if (file.type && !file.type.startsWith("video/")) {
      setStatus("That file is not a video. Choose a video file.", "is-error");
      return;
    }

    mediaReady = false;
    video.pause();
    revokeObjectUrl();
    clearSourceElements();

    objectUrl = URL.createObjectURL(file);
    video.removeAttribute("src");
    video.src = objectUrl;
    video.load();

    titleEl.textContent = file.name || "Local video";
    video.setAttribute("aria-label", file.name || "Local video");
    setStatus(`Loading ${file.name || "video"}…`);
    bigPlay.hidden = true;
    overlay.hidden = true;
    seek.value = "0";
    currentTimeEl.textContent = "0:00";
    durationEl.textContent = "0:00";
    setPlayingUi(false);
  }

  async function togglePlay() {
    if (!mediaReady) {
      setStatus(missingMessage, "is-error");
      return;
    }
    try {
      if (video.paused || video.ended) {
        await video.play();
      } else {
        video.pause();
      }
    } catch {
      setStatus("Playback failed. Check the media file.", "is-error");
    }
  }

  function toggleMute() {
    video.muted = !video.muted;
    setMuteUi(video.muted);
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement === stage) {
        await document.exitFullscreen();
        return;
      }
      if (stage.requestFullscreen) {
        await stage.requestFullscreen();
        return;
      }
      // Safari fallback
      if (typeof video.webkitEnterFullscreen === "function") {
        video.webkitEnterFullscreen();
      }
    } catch {
      setStatus("Fullscreen is not available here.", "is-error");
    }
  }

  function seekBy(deltaSeconds) {
    if (!mediaReady || !Number.isFinite(video.duration)) return;
    video.currentTime = Math.min(
      video.duration,
      Math.max(0, video.currentTime + deltaSeconds)
    );
    updateProgress();
  }

  function showControlsBriefly() {
    stage.classList.add("show-controls");
    window.clearTimeout(hideControlsTimer);
    hideControlsTimer = window.setTimeout(() => {
      if (!video.paused) stage.classList.remove("show-controls");
    }, 2200);
  }

  function markReady() {
    mediaReady = true;
    overlay.hidden = true;
    bigPlay.hidden = !video.paused;
    setStatus("Ready — press play or Space.", "is-ready");
    updateProgress();
    setPlayingUi(!video.paused);
  }

  function markMissing(message) {
    mediaReady = false;
    overlay.hidden = false;
    bigPlay.hidden = true;
    setStatus(message, "is-error");
    setPlayingUi(false);
    seek.value = "0";
    currentTimeEl.textContent = "0:00";
    durationEl.textContent = "0:00";
  }

  // Events
  playPause.addEventListener("click", () => {
    void togglePlay();
  });
  bigPlay.addEventListener("click", () => {
    void togglePlay();
  });
  muteBtn.addEventListener("click", toggleMute);
  fullscreenBtn.addEventListener("click", () => {
    void toggleFullscreen();
  });

  openFileBtn.addEventListener("click", () => {
    fileInput.click();
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    if (file) loadFile(file);
    fileInput.value = "";
  });

  stage.addEventListener("dragenter", (event) => {
    event.preventDefault();
    dragDepth += 1;
    stage.classList.add("is-dragover");
  });

  stage.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
    stage.classList.add("is-dragover");
  });

  stage.addEventListener("dragleave", (event) => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      stage.classList.remove("is-dragover");
    }
  });

  stage.addEventListener("drop", (event) => {
    event.preventDefault();
    dragDepth = 0;
    stage.classList.remove("is-dragover");
    const file = event.dataTransfer && event.dataTransfer.files[0];
    if (file) loadFile(file);
  });

  video.addEventListener("click", () => {
    void togglePlay();
  });

  video.addEventListener("play", () => setPlayingUi(true));
  video.addEventListener("pause", () => setPlayingUi(false));
  video.addEventListener("ended", () => {
    setPlayingUi(false);
    showControlsBriefly();
  });

  video.addEventListener("timeupdate", updateProgress);
  video.addEventListener("loadedmetadata", () => {
    if (Number.isFinite(video.duration) && video.duration > 0) {
      markReady();
    }
  });
  video.addEventListener("canplay", () => {
    if (!mediaReady) markReady();
  });
  video.addEventListener("volumechange", () => setMuteUi(video.muted));
  video.addEventListener("error", () => {
    if (objectUrl) {
      markMissing("Could not play that file. Try another video.");
      return;
    }
    markMissing("Could not load media/demo.mp4. Open a local video instead.");
  });
  video.addEventListener("emptied", () => {
    if (!video.currentSrc && !objectUrl) {
      markMissing(missingMessage);
    }
  });

  seek.addEventListener("pointerdown", () => {
    isSeeking = true;
  });
  seek.addEventListener("pointerup", () => {
    isSeeking = false;
  });
  seek.addEventListener("input", () => {
    if (!mediaReady || !Number.isFinite(video.duration) || video.duration <= 0) return;
    const next = (Number(seek.value) / 100) * video.duration;
    currentTimeEl.textContent = formatTime(next);
  });
  seek.addEventListener("change", () => {
    if (!mediaReady || !Number.isFinite(video.duration) || video.duration <= 0) return;
    video.currentTime = (Number(seek.value) / 100) * video.duration;
    isSeeking = false;
    updateProgress();
  });

  stage.addEventListener("mousemove", showControlsBriefly);
  stage.addEventListener("touchstart", showControlsBriefly, { passive: true });

  document.addEventListener("keydown", (event) => {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable)
    ) {
      return;
    }

    switch (event.key) {
      case " ":
      case "k":
      case "K":
        event.preventDefault();
        void togglePlay();
        showControlsBriefly();
        break;
      case "ArrowLeft":
        event.preventDefault();
        seekBy(-5);
        showControlsBriefly();
        break;
      case "ArrowRight":
        event.preventDefault();
        seekBy(5);
        showControlsBriefly();
        break;
      case "m":
      case "M":
        event.preventDefault();
        toggleMute();
        showControlsBriefly();
        break;
      case "f":
      case "F":
        event.preventDefault();
        void toggleFullscreen();
        showControlsBriefly();
        break;
      default:
        break;
    }
  });

  window.addEventListener("pagehide", revokeObjectUrl);

  // Initial state
  setPlayingUi(true);
  setMuteUi(video.muted);
  stage.classList.add("is-paused");
  setStatus("Waiting for media…");

  // If the source 404s, the error event handles it.
  // If metadata never arrives, surface a helpful empty state shortly after load.
  window.setTimeout(() => {
    if (!mediaReady && video.readyState < 1) {
      markMissing(missingMessage);
    }
  }, 900);
})();
