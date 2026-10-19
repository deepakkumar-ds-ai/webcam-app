const preview = document.querySelector("#camera-preview");
const previewFrame = document.querySelector("#preview-frame");
const backgroundPreview = document.querySelector("#background-preview");
const placeholder = document.querySelector("#preview-placeholder");
const startButton = document.querySelector("#start-button");
const placeholderConnect = document.querySelector("#placeholder-connect");
const cameraSelect = document.querySelector("#camera-select");
const frameRateSelect = document.querySelector("#frame-rate-select");
const zoomControl = document.querySelector("#zoom-level");
const zoomValue = document.querySelector("#zoom-value");
const captureButton = document.querySelector("#capture-button");
const mirrorButton = document.querySelector("#mirror-button");
const torchButton = document.querySelector("#torch-button");
const message = document.querySelector("#camera-message");
const connectionStatus = document.querySelector("#connection-status");
const connectionLabel = document.querySelector("#connection-label");
const liveTag = document.querySelector("#live-tag");
const lightTag = document.querySelector("#light-tag");
const lightLabel = document.querySelector("#light-label");
const resolutionLabel = document.querySelector("#resolution-label");
const previewFps = document.querySelector("#preview-fps");
const frameRateHint = document.querySelector("#frame-rate-hint");
const exposureState = document.querySelector("#exposure-state");
const focusState = document.querySelector("#focus-state");
const autoControlsHint = document.querySelector("#auto-controls-hint");
const backgroundModeSelect = document.querySelector("#background-mode");
const backgroundFileInput = document.querySelector("#background-file");
const backgroundUrlInput = document.querySelector("#background-url");
const backgroundUrlButton = document.querySelector("#background-url-button");
const backgroundStatus = document.querySelector("#background-status");
const backgroundContext = backgroundPreview.getContext("2d");

let stream = null;
let activeTrack = null;
let frameRateTimer = 0;
let brightnessTimer = 0;
let lastBrightness = null;
let requestedFrameRate = "auto";
let applyingFrameRate = false;
let torchEnabled = false;
let zoomLevel = 1;
let previousDecodedFrames = null;
let previousFrameSampleTime = 0;
let segmenter = null;
let segmenterPromise = null;
let backgroundFrameRequest = 0;
let segmentationBusy = false;
let backgroundMode = "off";
let backgroundFrameReady = false;
let backgroundImage = null;
let backgroundObjectUrl = null;

const backgroundPresets = {
  studio: {
    label: "Studio",
    url: "https://images.unsplash.com/photo-1497366754035-f200968a6e72?auto=format&fit=crop&w=1280&q=85",
  },
  coast: {
    label: "Coast",
    url: "https://images.unsplash.com/photo-1500375592092-40eb2168fd21?auto=format&fit=crop&w=1280&q=85",
  },
  mountains: {
    label: "Mountains",
    url: "https://images.unsplash.com/photo-1519681393784-d120267933ba?auto=format&fit=crop&w=1280&q=85",
  },
};

function setConnection(state, label) {
  connectionStatus.dataset.state = state;
  connectionLabel.textContent = label;
}

function explainCameraError(error) {
  if (error.name === "NotAllowedError" || error.name === "SecurityError") {
    return "Camera access was blocked. Allow camera permission in your browser, then try again.";
  }
  if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
    return "No camera was found. Connect a webcam and try again.";
  }
  if (error.name === "NotReadableError" || error.name === "TrackStartError") {
    return "The camera could not start. Close other apps using it, then try again.";
  }
  if (error.name === "OverconstrainedError" || error.name === "ConstraintNotSatisfiedError") {
    return "This camera cannot provide the requested settings. Try another camera or frame rate.";
  }
  return `Could not connect to the camera (${error.message || error.name}).`;
}

function getVideoConstraints(deviceId) {
  const video = {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30, max: 60 },
  };
  if (deviceId) video.deviceId = { exact: deviceId };
  return { audio: false, video };
}

function stopPreviewMonitoring() {
  clearInterval(frameRateTimer);
  clearInterval(brightnessTimer);
  frameRateTimer = 0;
  brightnessTimer = 0;
  previewFps.textContent = "";
  previousDecodedFrames = null;
  previousFrameSampleTime = 0;
}

function stopCamera() {
  stopPreviewMonitoring();
  stopBackgroundProcessing();
  backgroundMode = "off";
  backgroundFrameReady = false;
  backgroundPreview.hidden = true;
  preview.classList.remove("is-effect-source");
  if (stream) stream.getTracks().forEach((track) => track.stop());
  stream = null;
  activeTrack = null;
  preview.srcObject = null;
  preview.classList.remove("is-visible");
  placeholder.hidden = false;
  liveTag.hidden = true;
  lightTag.hidden = true;
  captureButton.disabled = true;
  frameRateSelect.disabled = true;
  zoomControl.disabled = true;
  zoomLevel = 1;
  zoomControl.value = "1";
  zoomValue.value = "1.0×";
  previewFrame.style.setProperty("--preview-zoom", "1");
  backgroundModeSelect.disabled = true;
  cameraSelect.disabled = true;
  mirrorButton.disabled = true;
  torchButton.disabled = true;
  torchButton.title = "Camera light not available";
  torchButton.setAttribute("aria-pressed", "false");
  torchEnabled = false;
  resolutionLabel.textContent = "Waiting for camera";
  exposureState.textContent = "—";
  exposureState.classList.remove("is-active");
  focusState.textContent = "—";
  focusState.classList.remove("is-active");
  lastBrightness = null;
}

async function refreshCameraList(selectedDeviceId = "") {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter((device) => device.kind === "videoinput");
  cameraSelect.replaceChildren();

  if (cameras.length === 0) {
    cameraSelect.add(new Option("No cameras found", ""));
    cameraSelect.disabled = true;
    return;
  }

  cameras.forEach((camera, index) => {
    const label = camera.label || `Camera ${index + 1}`;
    cameraSelect.add(new Option(label, camera.deviceId));
  });

  const selected = cameras.find((camera) => camera.deviceId === selectedDeviceId);
  cameraSelect.value = selected ? selected.deviceId : cameras[0].deviceId;
  cameraSelect.disabled = false;
}

function supportsMode(capabilities, key, mode) {
  return Array.isArray(capabilities[key]) && capabilities[key].includes(mode);
}

async function enableAutomaticControls(track) {
  const capabilities = track.getCapabilities ? track.getCapabilities() : {};
  const automaticModes = [
    { key: "exposureMode", mode: "continuous", label: "Auto exposure", element: exposureState },
    { key: "focusMode", mode: "continuous", label: "Continuous focus", element: focusState },
    { key: "whiteBalanceMode", mode: "continuous", label: "Auto white balance", element: null },
  ];
  const supportedModes = automaticModes.filter(({ key, mode }) => supportsMode(capabilities, key, mode));
  const constraints = {};
  supportedModes.forEach(({ key, mode }) => {
    constraints[key] = mode;
  });
  const useGainControl = !supportsMode(capabilities, "exposureMode", "continuous") && capabilities.autoGainControl;
  if (useGainControl) constraints.autoGainControl = true;

  if (Object.keys(constraints).length) {
    try {
      await track.applyConstraints({ advanced: [constraints] });
      supportedModes.forEach(({ element }) => {
        if (!element) return;
        element.textContent = "On";
        element.classList.add("is-active");
      });
      if (useGainControl) {
        exposureState.textContent = "Gain on";
        exposureState.classList.add("is-active");
      }
    } catch (error) {
      console.warn("Could not enable the camera's automatic controls.", error);
      supportedModes.forEach(({ element }) => {
        if (element) element.textContent = "Unavailable";
      });
      if (useGainControl) exposureState.textContent = "Unavailable";
    }
  }

  automaticModes.forEach(({ key, mode, element }) => {
    if (element && !supportsMode(capabilities, key, mode) && !(element === exposureState && useGainControl)) {
      element.textContent = "Not supported";
    }
  });

  autoControlsHint.textContent = supportedModes.length || useGainControl
    ? "Enabled wherever your camera supports it"
    : "Automatic focus and exposure depend on your camera";

  const supportsTorch = capabilities.torch === true;
  torchButton.disabled = !supportsTorch;
  torchButton.title = supportsTorch ? "Toggle camera light" : "This camera has no controllable light";
}

function loadSegmentationLibrary() {
  if (window.SelfieSegmentation) return Promise.resolve(window.SelfieSegmentation);
  if (!segmenterPromise) {
    segmenterPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1.1675465747/selfie_segmentation.js";
      script.async = true;
      script.onload = () => {
        if (window.SelfieSegmentation) resolve(window.SelfieSegmentation);
        else reject(new Error("The background-removal library did not load."));
      };
      script.onerror = () => reject(new Error("The background-removal library could not be downloaded."));
      document.head.append(script);
    }).catch((error) => {
      segmenterPromise = null;
      throw error;
    });
  }
  return segmenterPromise;
}

async function ensureSegmenter() {
  if (segmenter) return;
  const SelfieSegmentation = await loadSegmentationLibrary();
  const nextSegmenter = new SelfieSegmentation({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1.1675465747/${file}`,
  });
  await nextSegmenter.setOptions({ modelSelection: 1 });
  nextSegmenter.onResults(drawBackgroundResult);
  segmenter = nextSegmenter;
}

function stopBackgroundProcessing() {
  if (backgroundFrameRequest) cancelAnimationFrame(backgroundFrameRequest);
  backgroundFrameRequest = 0;
}

function drawCoverImage(context, image, width, height) {
  const scale = Math.max(width / image.width, height / image.height);
  const scaledWidth = image.width * scale;
  const scaledHeight = image.height * scale;
  context.drawImage(image, (width - scaledWidth) / 2, (height - scaledHeight) / 2, scaledWidth, scaledHeight);
}

function drawBackgroundResult(results) {
  if (!backgroundContext || !preview.videoWidth || backgroundMode === "off") return;
  const width = preview.videoWidth;
  const height = preview.videoHeight;
  if (backgroundPreview.width !== width || backgroundPreview.height !== height) {
    backgroundPreview.width = width;
    backgroundPreview.height = height;
  }

  const context = backgroundContext;
  context.clearRect(0, 0, width, height);
  context.drawImage(preview, 0, 0, width, height);
  context.globalCompositeOperation = "destination-in";
  context.drawImage(results.segmentationMask, 0, 0, width, height);
  context.globalCompositeOperation = "destination-over";

  if (backgroundMode === "blur") {
    context.filter = "blur(18px)";
    context.drawImage(preview, -18, -18, width + 36, height + 36);
    context.filter = "none";
  } else if (backgroundMode === "replace" && backgroundImage) {
    drawCoverImage(context, backgroundImage, width, height);
  }
  context.globalCompositeOperation = "source-over";
  backgroundFrameReady = true;
}

async function processBackgroundFrame() {
  if (!segmenter || !activeTrack || backgroundMode === "off") return;
  if (segmentationBusy || preview.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    backgroundFrameRequest = requestAnimationFrame(processBackgroundFrame);
    return;
  }

  segmentationBusy = true;
  try {
    await segmenter.send({ image: preview });
  } catch (error) {
    console.error("Could not process the live background.", error);
    backgroundModeSelect.value = "off";
    backgroundMode = "off";
    backgroundPreview.hidden = true;
    preview.classList.remove("is-effect-source");
    backgroundStatus.textContent = "Background processing stopped. Try reconnecting or reloading the page.";
  } finally {
    segmentationBusy = false;
    if (backgroundMode !== "off" && activeTrack) {
      backgroundFrameRequest = requestAnimationFrame(processBackgroundFrame);
    }
  }
}

async function applyBackgroundMode() {
  const requestedMode = backgroundModeSelect.value;
  stopBackgroundProcessing();
  if (requestedMode === "off") {
    backgroundMode = "off";
    backgroundFrameReady = false;
    backgroundPreview.hidden = true;
    preview.classList.remove("is-effect-source");
    backgroundStatus.textContent = "Original background.";
    return;
  }
  if (!activeTrack) {
    backgroundStatus.textContent = "Connect your camera to turn on live background effects.";
    return;
  }
  if (requestedMode === "replace" && !backgroundImage) {
    backgroundModeSelect.value = "off";
    backgroundMode = "off";
    backgroundStatus.textContent = "Add or choose a photo before selecting Replace with photo.";
    return;
  }

  backgroundMode = requestedMode;
  backgroundFrameReady = false;
  backgroundStatus.textContent = "Loading live background effects…";
  try {
    await ensureSegmenter();
    if (!activeTrack || backgroundModeSelect.value !== requestedMode) return;
    backgroundPreview.hidden = false;
    preview.classList.add("is-effect-source");
    backgroundStatus.textContent = requestedMode === "remove"
      ? "Background removed live. Snapshots save as transparent PNGs."
      : requestedMode === "blur"
        ? "Background blur is on."
        : "Photo background is on.";
    backgroundFrameRequest = requestAnimationFrame(processBackgroundFrame);
  } catch (error) {
    console.error("Could not initialize live background effects.", error);
    backgroundMode = "off";
    backgroundModeSelect.value = "off";
    backgroundPreview.hidden = true;
    preview.classList.remove("is-effect-source");
    backgroundStatus.textContent = "Could not load background effects. Check your internet connection and try again.";
  }
}

async function useBackgroundImage(blob, label) {
  if (!blob.type.startsWith("image/")) {
    throw new Error("Choose a supported image file.");
  }
  const nextObjectUrl = URL.createObjectURL(blob);
  const nextImage = new Image();
  try {
    await new Promise((resolve, reject) => {
      nextImage.onload = resolve;
      nextImage.onerror = () => reject(new Error("The selected image could not be opened."));
      nextImage.src = nextObjectUrl;
    });
  } catch (error) {
    URL.revokeObjectURL(nextObjectUrl);
    throw error;
  }

  if (backgroundObjectUrl) URL.revokeObjectURL(backgroundObjectUrl);
  backgroundObjectUrl = nextObjectUrl;
  backgroundImage = nextImage;
  backgroundModeSelect.value = "replace";
  backgroundStatus.textContent = `${label} added. Choose Replace with photo when your camera is connected.`;
  if (activeTrack) await applyBackgroundMode();
}

async function loadBackgroundFromUrl(value, label = "Internet photo") {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid HTTPS image URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error("For safety, internet photos must use an HTTPS URL.");
  }

  let response;
  try {
    response = await fetch(url, { mode: "cors" });
  } catch {
    throw new Error("Could not fetch that image. Use a direct HTTPS image URL from a server that allows cross-origin access.");
  }
  if (!response.ok) throw new Error(`The image server responded with ${response.status}.`);
  const image = await response.blob();
  if (!image.type.startsWith("image/")) {
    throw new Error("That URL did not return an image. Use a direct image link.");
  }
  await useBackgroundImage(image, label);
}

async function startCamera(deviceId = "") {
  if (!navigator.mediaDevices?.getUserMedia) {
    setConnection("error", "Camera unavailable");
    message.textContent = "Camera access needs a modern browser and a secure page (HTTPS or localhost).";
    return;
  }

  startButton.disabled = true;
  startButton.querySelector("span").textContent = "Connecting…";
  message.textContent = "";
  stopCamera();

  try {
    stream = await navigator.mediaDevices.getUserMedia(getVideoConstraints(deviceId));
  } catch (error) {
    setConnection("error", "Connection failed");
    message.textContent = explainCameraError(error);
    try {
      await refreshCameraList(deviceId);
    } catch (listError) {
      console.error("Could not refresh the camera list after a failed connection.", listError);
    }
    startButton.disabled = false;
    startButton.querySelector("span").textContent = "Connect camera";
    return;
  }

  activeTrack = stream.getVideoTracks()[0];
  preview.srcObject = stream;
  preview.classList.add("is-visible");
  placeholder.hidden = true;
  liveTag.hidden = false;
  lightTag.hidden = false;
  captureButton.disabled = false;
  frameRateSelect.disabled = false;
  zoomControl.disabled = false;
  backgroundModeSelect.disabled = false;
  mirrorButton.disabled = false;
  setConnection("online", "Camera connected");
  startButton.disabled = false;
  startButton.querySelector("span").textContent = "Reconnect";

  try {
    await refreshCameraList(activeTrack.getSettings().deviceId || deviceId);
  } catch (error) {
    console.error("The camera connected, but the camera list could not be refreshed.", error);
    message.textContent = "Camera connected, but the camera list could not be refreshed.";
  }
  await enableAutomaticControls(activeTrack);
  updateCameraDetails();
  await applySelectedFrameRate();
  if (backgroundModeSelect.value !== "off") await applyBackgroundMode();
  startPreviewMonitoring();
  message.textContent = "";
  activeTrack.addEventListener("ended", handleCameraEnded, { once: true });
}

function updateCameraDetails() {
  if (!activeTrack) return;
  const settings = activeTrack.getSettings();
  if (settings.width && settings.height) {
    resolutionLabel.textContent = `${settings.width} × ${settings.height}`;
  }
  if (settings.frameRate) {
    previewFps.textContent = `${Math.round(settings.frameRate)} FPS`;
  }
}

function updateZoom() {
  zoomLevel = Number(zoomControl.value);
  zoomValue.value = `${zoomLevel.toFixed(1)}×`;
  previewFrame.style.setProperty("--preview-zoom", String(zoomLevel));
}

function startPreviewMonitoring() {
  previousFrameSampleTime = performance.now();
  previousDecodedFrames = preview.getVideoPlaybackQuality?.().totalVideoFrames ?? null;
  frameRateTimer = window.setInterval(() => {
    updateCameraDetails();
    updateMeasuredFrameRate();
  }, 1500);
  brightnessTimer = window.setInterval(sampleBrightness, 2500);
}

function updateMeasuredFrameRate() {
  if (!activeTrack || preview.paused || preview.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  const playbackQuality = preview.getVideoPlaybackQuality?.();
  const totalFrames = playbackQuality?.totalVideoFrames;
  const now = performance.now();
  const elapsed = now - previousFrameSampleTime;
  const configuredFrameRate = activeTrack.getSettings().frameRate;

  if (typeof totalFrames === "number" && previousDecodedFrames !== null && elapsed > 0) {
    const measured = Math.round(((totalFrames - previousDecodedFrames) * 1000) / elapsed);
    previewFps.textContent = `${measured || Math.round(configuredFrameRate || 0)} FPS`;
  } else {
    previewFps.textContent = configuredFrameRate ? `${Math.round(configuredFrameRate)} FPS` : "";
  }
  previousDecodedFrames = typeof totalFrames === "number" ? totalFrames : null;
  previousFrameSampleTime = now;
}

function sampleBrightness() {
  if (!activeTrack || requestedFrameRate !== "auto" || preview.videoWidth === 0) return;
  const canvas = document.createElement("canvas");
  canvas.width = 24;
  canvas.height = 14;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return;

  context.drawImage(preview, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let total = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    total += 0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2];
  }
  lastBrightness = total / (pixels.length / 4);
  const capabilities = activeTrack.getCapabilities ? activeTrack.getCapabilities() : {};
  const maxFrameRate = capabilities.frameRate?.max || activeTrack.getSettings().frameRate || 30;

  if (lastBrightness < 65) {
    lightLabel.textContent = "Low light · 30 FPS";
    if (maxFrameRate >= 30) setFrameRate(30, true);
  } else if (lastBrightness > 95 && maxFrameRate >= 60) {
    lightLabel.textContent = "Bright · 60 FPS";
    setFrameRate(60, true);
  } else {
    lightLabel.textContent = maxFrameRate >= 60 ? "Balanced · 30 FPS" : "Auto light";
    setFrameRate(30, true);
  }
}

async function setFrameRate(target, automatic = false) {
  if (!activeTrack || applyingFrameRate) return;
  const current = activeTrack.getSettings().frameRate;
  if (current && Math.abs(current - target) < 2) {
    updateCameraDetails();
    return;
  }

  applyingFrameRate = true;
  try {
    await activeTrack.applyConstraints({ frameRate: { ideal: target, max: target } });
    updateCameraDetails();
    frameRateHint.textContent = automatic
      ? `Smart auto is using ${target} FPS for the current light.`
      : `Camera is set to ${target} FPS.`;
  } catch (error) {
    console.warn(`Could not set camera frame rate to ${target} FPS.`, error);
    if (!automatic) {
      message.textContent = explainCameraError(error);
    } else {
      lightLabel.textContent = "Camera-managed light";
      frameRateHint.textContent = "Your camera is managing its frame rate automatically.";
    }
  } finally {
    applyingFrameRate = false;
  }
}

async function applySelectedFrameRate() {
  if (!activeTrack) return;
  requestedFrameRate = frameRateSelect.value;
  const capabilities = activeTrack.getCapabilities ? activeTrack.getCapabilities() : {};
  const maxFrameRate = capabilities.frameRate?.max || activeTrack.getSettings().frameRate || 30;

  if (requestedFrameRate === "auto") {
    frameRateHint.textContent = "Smart auto will balance brightness and motion.";
    if (lastBrightness === null) {
      const initialTarget = maxFrameRate >= 60 ? 30 : Math.min(30, maxFrameRate);
      await setFrameRate(initialTarget, true);
    }
    return;
  }

  const requested = Number(requestedFrameRate);
  if (requested > maxFrameRate) {
    message.textContent = `This camera supports up to ${Math.floor(maxFrameRate)} FPS.`;
    frameRateSelect.value = "auto";
    requestedFrameRate = "auto";
    return;
  }
  await setFrameRate(requested);
}

async function toggleTorch() {
  if (!activeTrack) return;
  const nextState = !torchEnabled;
  try {
    await activeTrack.applyConstraints({ advanced: [{ torch: nextState }] });
    torchEnabled = nextState;
    torchButton.setAttribute("aria-pressed", String(torchEnabled));
  } catch (error) {
    message.textContent = `Could not change the camera light (${error.message || error.name}).`;
  }
}

function captureSnapshot() {
  if (!activeTrack || !preview.videoWidth) return;
  if (backgroundMode !== "off" && !backgroundFrameReady) {
    backgroundStatus.textContent = "Wait for the live background effect to load before taking a snapshot.";
    return;
  }
  const canvas = document.createElement("canvas");
  const source = backgroundMode !== "off" ? backgroundPreview : preview;
  canvas.width = source.videoWidth || source.width || preview.videoWidth;
  canvas.height = source.videoHeight || source.height || preview.videoHeight;
  const context = canvas.getContext("2d");
  if (!context) {
    message.textContent = "Could not create a snapshot in this browser.";
    return;
  }

  if (mirrorButton.getAttribute("aria-pressed") === "true") {
    context.translate(canvas.width, 0);
    context.scale(-1, 1);
  }
  const cropWidth = canvas.width / zoomLevel;
  const cropHeight = canvas.height / zoomLevel;
  context.drawImage(
    source,
    (canvas.width - cropWidth) / 2,
    (canvas.height - cropHeight) / 2,
    cropWidth,
    cropHeight,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  const transparent = backgroundMode === "remove";
  const imageType = transparent ? "image/png" : "image/jpeg";
  const extension = transparent ? "png" : "jpg";
  canvas.toBlob((blob) => {
    if (!blob) {
      message.textContent = "The browser could not save this snapshot.";
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `focus-snapshot-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    message.textContent = "Snapshot saved to your downloads.";
    window.setTimeout(() => {
      if (message.textContent === "Snapshot saved to your downloads.") message.textContent = "";
    }, 3000);
  }, imageType, 0.94);
}

function handleCameraEnded() {
  stopCamera();
  setConnection("offline", "Camera disconnected");
  startButton.disabled = false;
  startButton.querySelector("span").textContent = "Reconnect";
  message.textContent = "The camera disconnected. Reconnect it and try again.";
}

startButton.addEventListener("click", () => startCamera(cameraSelect.value));
placeholderConnect.addEventListener("click", () => startCamera(cameraSelect.value));
cameraSelect.addEventListener("change", () => startCamera(cameraSelect.value));
frameRateSelect.addEventListener("change", applySelectedFrameRate);
zoomControl.addEventListener("input", updateZoom);
captureButton.addEventListener("click", captureSnapshot);
torchButton.addEventListener("click", toggleTorch);
mirrorButton.addEventListener("click", () => {
  const mirrored = mirrorButton.getAttribute("aria-pressed") !== "true";
  mirrorButton.setAttribute("aria-pressed", String(mirrored));
  preview.classList.toggle("is-mirrored", mirrored);
  backgroundPreview.classList.toggle("is-mirrored", mirrored);
});
backgroundModeSelect.addEventListener("change", applyBackgroundMode);
backgroundFileInput.addEventListener("change", async () => {
  const [file] = backgroundFileInput.files;
  if (!file) return;
  try {
    await useBackgroundImage(file, "Your photo");
  } catch (error) {
    console.error("Could not use the selected background photo.", error);
    backgroundStatus.textContent = error.message || "Could not open that photo.";
  }
  backgroundFileInput.value = "";
});
backgroundUrlButton.addEventListener("click", async () => {
  const url = backgroundUrlInput.value.trim();
  if (!url) {
    backgroundStatus.textContent = "Enter a direct HTTPS image URL first.";
    return;
  }
  backgroundUrlButton.disabled = true;
  backgroundStatus.textContent = "Loading internet photo…";
  try {
    await loadBackgroundFromUrl(url);
  } catch (error) {
    console.error("Could not load the internet background photo.", error);
    backgroundStatus.textContent = error.message || "Could not load that photo. Check its URL and CORS settings.";
  } finally {
    backgroundUrlButton.disabled = false;
  }
});
document.querySelectorAll("[data-background-preset]").forEach((button) => {
  button.addEventListener("click", async () => {
    const preset = backgroundPresets[button.dataset.backgroundPreset];
    if (!preset) return;
    button.disabled = true;
    backgroundStatus.textContent = `Loading ${preset.label.toLowerCase()} background…`;
    try {
      await loadBackgroundFromUrl(preset.url, `${preset.label} photo`);
    } catch (error) {
      console.error(`Could not load the ${preset.label.toLowerCase()} background.`, error);
      backgroundStatus.textContent = "Could not load the sample photo. Check your internet connection and try again.";
    } finally {
      button.disabled = false;
    }
  });
});

if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", async () => {
    try {
      await refreshCameraList(activeTrack?.getSettings().deviceId || "");
    } catch (error) {
      console.error("Could not refresh the camera list.", error);
      message.textContent = "Could not refresh the camera list. Reload the page to try again.";
    }
  });
}

window.addEventListener("pagehide", () => {
  stopCamera();
  if (backgroundObjectUrl) URL.revokeObjectURL(backgroundObjectUrl);
});
