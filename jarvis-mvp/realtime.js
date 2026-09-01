import {
  classifyTurnTaking,
  createVoiceMetrics,
  isAssistantSpeaking,
  markVoiceMetric,
  voiceDirectiveForText
} from "./voiceRuntime.js";

const GEMINI_CAPTURE_BUFFER_SIZE = 4096;
const GEMINI_PLAYBACK_LEAD_SECONDS = 0.32;
const GEMINI_PLAYBACK_RAMP_SECONDS = 0.004;
const GEMINI_CONTINUOUS_QUEUE_THRESHOLD_SECONDS = 0.015;
const GEMINI_RESUME_BUFFER_SECONDS = 0.42;
const GEMINI_RESUME_MAX_WAIT_MS = 360;
const GEMINI_MIC_SUPPRESSION_TAIL_MS = 180;

export class RealtimeClient {
  constructor({ onEvent, onStatus, onTranscript, onToolCall, onVoiceMetrics, sessionToken }) {
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.onTranscript = onTranscript;
    this.onToolCall = onToolCall || (async () => ({ ok: false, error: "Tool handler unavailable." }));
    this.onVoiceMetrics = onVoiceMetrics || (() => {});
    this.sessionToken = sessionToken || (() => "");
    this.pc = null;
    this.dc = null;
    this.ws = null;
    this.stream = null;
    this.audio = null;
    this.audioContext = null;
    this.source = null;
    this.processor = null;
    this.captureSilence = null;
    this.assistantGain = null;
    this.playbackTime = 0;
    this.audioSources = new Set();
    this.pendingAudioBuffers = [];
    this.playbackTimer = null;
    this.firstPendingAudioAt = 0;
    this.muteAssistantAudioUntil = 0;
    this.micSuppressedUntil = 0;
    this.lastMicSuppressionEventAt = 0;
    this.voiceMetrics = createVoiceMetrics();
    this.handledToolCalls = new Set();
  }

  async connect() {
    const status = await fetch("/api/status").then((response) => response.json()).catch(() => ({}));
    if (!status.realtimeEnabled) {
      throw new Error(status.voice?.fallbackReason || "Voice realtime provider is not configured.");
    }
    if (status.realtimeProvider === "gemini") {
      return this.connectGemini();
    }
    return this.connectOpenAI();
  }

  async connectOpenAI() {
    if (!window.RTCPeerConnection) {
      throw new Error("WebRTC is not available in this browser.");
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone capture is not available in this browser.");
    }

    this.markVoice("capture-requested", { provider: "openai" });
    this.onStatus("requesting-microphone");
    this.pc = new RTCPeerConnection();
    this.audio = document.createElement("audio");
    this.audio.autoplay = true;
    this.audio.playsInline = true;
    this.audio.hidden = true;
    this.audio.volume = 0.85;
    document.body.append(this.audio);
    this.pc.ontrack = (event) => {
      this.audio.srcObject = event.streams[0];
      this.audio.play().catch((error) => {
        this.onEvent({ type: "aura.audio.playback_blocked", error: error.message });
      });
    };
    this.pc.onconnectionstatechange = () => {
      this.onEvent({ type: "webrtc.connection_state", state: this.pc?.connectionState });
    };
    this.pc.oniceconnectionstatechange = () => {
      this.onEvent({ type: "webrtc.ice_state", state: this.pc?.iceConnectionState });
    };

    this.stream = await requestMicrophoneStream();
    this.markVoice("microphone-ready");
    this.pc.addTrack(this.stream.getAudioTracks()[0], this.stream);

    this.dc = this.pc.createDataChannel("oai-events");
    this.dc.addEventListener("open", () => {
      this.updateSession().finally(() => {
        this.onStatus("standby");
      });
    });
    this.dc.addEventListener("message", (event) => this.handleEvent(event));
    this.dc.addEventListener("error", (event) => {
      this.onEvent({ type: "webrtc.data_channel_error", error: event.error?.message || "Data channel error." });
    });
    this.dc.addEventListener("close", () => this.onStatus("closed"));

    this.onStatus("negotiating");
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    const sdpResponse = await fetch("/api/realtime/call", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AURA-Session": this.sessionToken()
      },
      body: JSON.stringify({ sdp: offer.sdp })
    });

    if (!sdpResponse.ok) {
      throw await realtimeApiError(sdpResponse);
    }

    await this.pc.setRemoteDescription({
      type: "answer",
      sdp: await sdpResponse.text()
    });
  }

  async connectGemini() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone capture is not available in this browser.");
    }
    if (!window.AudioContext && !window.webkitAudioContext) {
      throw new Error("AudioContext is not available in this browser.");
    }

    this.markVoice("capture-requested", { provider: "gemini" });
    this.onStatus("connecting-gemini");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    this.ws = new WebSocket(`${protocol}//${window.location.host}/api/gemini/live?session=${encodeURIComponent(this.sessionToken())}`);
    this.ws.addEventListener("message", (event) => this.handleGeminiEvent(event));
    this.ws.addEventListener("error", () => {
      this.onEvent({ type: "gemini.websocket_error" });
    });
    this.ws.addEventListener("close", () => this.onStatus("closed"));

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Gemini Live connection timed out.")), 15000);
      this.ws.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      this.ws.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("Gemini Live WebSocket failed."));
      }, { once: true });
    });

    this.onStatus("requesting-microphone");
    this.stream = await requestMicrophoneStream();
    this.markVoice("microphone-ready");
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    this.audioContext = new AudioContextCtor();
    await this.audioContext.resume();
    this.playbackTime = this.audioContext.currentTime;
    this.assistantGain = this.audioContext.createGain();
    this.assistantGain.gain.value = 0.85;
    this.assistantGain.connect(this.audioContext.destination);
    this.source = this.audioContext.createMediaStreamSource(this.stream);
    this.processor = this.audioContext.createScriptProcessor(GEMINI_CAPTURE_BUFFER_SIZE, 1, 1);
    this.captureSilence = this.audioContext.createGain();
    this.captureSilence.gain.value = 0;
    this.processor.onaudioprocess = (event) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      if (this.shouldSuppressMicrophoneForPlayback()) {
        return;
      }
      const pcm = floatTo16BitPcm(downsampleBuffer(event.inputBuffer.getChannelData(0), this.audioContext.sampleRate, 16000));
      this.ws.send(JSON.stringify({
        type: "audio",
        data: arrayBufferToBase64(pcm.buffer),
        mimeType: "audio/pcm;rate=16000"
      }));
    };
    this.source.connect(this.processor);
    this.processor.connect(this.captureSilence);
    this.captureSilence.connect(this.audioContext.destination);
    this.onEvent({
      type: "aura.audio.capture_constraints",
      constraints: microphoneAudioConstraints()
    });
  }

  disconnect() {
    this.dc?.close();
    this.ws?.close();
    this.pc?.close();
    this.processor?.disconnect();
    this.captureSilence?.disconnect();
    this.source?.disconnect();
    this.stopAssistantAudio();
    this.assistantGain?.disconnect();
    this.clearPendingGeminiAudio();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.audio?.remove();
    this.audioContext?.close().catch(() => {});
    this.pc = null;
    this.dc = null;
    this.ws = null;
    this.stream = null;
    this.audio = null;
    this.audioContext = null;
    this.source = null;
    this.processor = null;
    this.captureSilence = null;
    this.assistantGain = null;
    this.playbackTime = 0;
    this.pendingAudioBuffers = [];
    this.playbackTimer = null;
    this.firstPendingAudioAt = 0;
    this.muteAssistantAudioUntil = 0;
    this.micSuppressedUntil = 0;
    this.lastMicSuppressionEventAt = 0;
    this.handledToolCalls.clear();
    this.markVoice("closed");
    this.onStatus("idle");
  }

  send(event) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
      return true;
    }
    if (!this.dc || this.dc.readyState !== "open") {
      return false;
    }

    this.dc.send(JSON.stringify(event));
    return true;
  }

  sendText(text, attachments = []) {
    const turn = classifyTurnTaking(text);
    this.markVoice("user-input", { text });
    this.onEvent({ type: "aura.voice.turn_taking", ...turn });
    if (turn.shouldSummarize && isAssistantSpeaking(this.voiceMetrics)) {
      this.interruptAssistant("summary-request");
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: "text",
        text: this.textWithAttachmentContext(text, attachments)
      }));
      return true;
    }

    const content = [{ type: "input_text", text: this.textWithAttachmentContext(text, attachments) }];
    for (const attachment of attachments) {
      if (attachment.type?.startsWith("image/") && attachment.dataUrl) {
        content.push({ type: "input_image", image_url: attachment.dataUrl });
      }
    }

    const ok = this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content
      }
    });
    if (ok) {
      this.send({ type: "response.create" });
    }
    return ok;
  }

  async updateSession() {
    try {
      const response = await fetch("/api/realtime/config");
      if (!response.ok) {
        throw new Error("Could not load Realtime session config.");
      }
      const payload = await response.json();
      const { type, model, ...session } = payload.session || {};
      this.send({
        type: "session.update",
        session
      });
      this.onEvent({ type: "aura.session_update.sent" });
    } catch (error) {
      this.onEvent({ type: "aura.session_update.failed", error: error.message });
    }
  }

  handleEvent(event) {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (error) {
      this.onEvent({ type: "webrtc.event_parse_failed", error: error.message });
      return;
    }
    this.onEvent(data);

    const toolCall = this.toolCallFromEvent(data);
    if (toolCall) {
      this.handleToolCall(toolCall).catch((error) => {
        this.onEvent({ type: "aura.tool.failed", error: error.message });
      });
    }

    if (data.type === "input_audio_buffer.speech_started") {
      this.interruptAssistant("barge-in");
      this.markVoice("user-input", { text: "" });
    }

    if (data.type === "conversation.item.input_audio_transcription.completed") {
      this.markVoice("user-input", { text: data.transcript || "" });
    }

    if (data.type === "response.audio_transcript.delta" || data.type === "response.output_text.delta") {
      this.markVoice("assistant-first-output");
      this.onTranscript(data.delta || "");
    }

    if (data.type === "response.done") {
      this.markVoice("assistant-output-done");
    }
  }

  handleGeminiEvent(event) {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (error) {
      this.onEvent({ type: "gemini.event_parse_failed", error: error.message });
      return;
    }
    this.onEvent({ type: data.type || "gemini.event", data });

    if (data.setupComplete) {
      this.onStatus("standby");
    }

    const serverContent = data.serverContent;
    if (serverContent?.inputTranscription?.text) {
      this.handleUserSpeech(serverContent.inputTranscription.text);
      this.onEvent({ type: "gemini.input_transcription", text: serverContent.inputTranscription.text });
    }
    if (serverContent?.outputTranscription?.text) {
      this.markVoice("assistant-first-output");
      this.onTranscript(serverContent.outputTranscription.text);
    }
    for (const part of serverContent?.modelTurn?.parts || []) {
      if (part.inlineData?.data) {
        this.markVoice("assistant-first-output");
        this.playPcmAudio(part.inlineData.data, mimeRate(part.inlineData.mimeType) || 24000);
      }
    }

    if (serverContent?.generationComplete || serverContent?.turnComplete) {
      this.markVoice("assistant-output-done");
    }

    if (data.toolCall?.functionCalls) {
      this.handleGeminiToolCall(data.toolCall).catch((error) => {
        this.onEvent({ type: "gemini.tool.failed", error: error.message });
      });
    }
  }

  async handleGeminiToolCall(toolCall) {
    const functionResponses = [];
    for (const call of toolCall.functionCalls || []) {
      const callId = call.id || `${call.name}:${JSON.stringify(call.args || {})}`;
      if (this.handledToolCalls.has(callId)) {
        continue;
      }
      this.handledToolCalls.add(callId);
      const output = await this.onToolCall({
        callId,
        name: call.name,
        arguments: JSON.stringify(call.args || {})
      });
      functionResponses.push({
        id: call.id,
        name: call.name,
        response: { result: output }
      });
    }
    if (functionResponses.length && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: "toolResponse",
        functionResponses
      }));
    }
  }

  playPcmAudio(base64Audio, sampleRate) {
    if (!this.audioContext) {
      return;
    }
    if (performance.now() < this.muteAssistantAudioUntil) {
      this.markVoice("late-response-dropped");
      this.onEvent({ type: "aura.voice.late_audio_dropped" });
      return;
    }
    const pcm = base64ToInt16Array(base64Audio);
    const audioBuffer = this.audioContext.createBuffer(1, pcm.length, sampleRate);
    const channel = audioBuffer.getChannelData(0);
    for (let index = 0; index < pcm.length; index += 1) {
      channel[index] = Math.max(-1, Math.min(1, pcm[index] / 32768));
    }
    this.pendingAudioBuffers.push(audioBuffer);
    if (!this.firstPendingAudioAt) {
      this.firstPendingAudioAt = performance.now();
    }
    this.scheduleGeminiPlayback();
  }

  scheduleGeminiPlayback() {
    if (!this.audioContext || !this.pendingAudioBuffers.length) {
      return;
    }
    const currentTime = this.audioContext.currentTime;
    if (this.playbackTime > currentTime + GEMINI_CONTINUOUS_QUEUE_THRESHOLD_SECONDS) {
      this.flushGeminiPlayback();
      return;
    }
    const pendingDuration = this.pendingAudioBuffers.reduce((total, buffer) => total + buffer.duration, 0);
    const waitedMs = performance.now() - this.firstPendingAudioAt;
    if (pendingDuration >= GEMINI_RESUME_BUFFER_SECONDS || waitedMs >= GEMINI_RESUME_MAX_WAIT_MS) {
      this.flushGeminiPlayback();
      return;
    }
    if (!this.playbackTimer) {
      this.playbackTimer = setTimeout(() => {
        this.playbackTimer = null;
        this.flushGeminiPlayback();
      }, Math.max(30, GEMINI_RESUME_MAX_WAIT_MS - waitedMs));
    }
  }

  flushGeminiPlayback() {
    if (!this.audioContext || !this.pendingAudioBuffers.length) {
      return;
    }
    if (this.playbackTimer) {
      clearTimeout(this.playbackTimer);
      this.playbackTimer = null;
    }
    const currentTime = this.audioContext.currentTime;
    let continuesQueuedAudio = this.playbackTime > currentTime + GEMINI_CONTINUOUS_QUEUE_THRESHOLD_SECONDS;
    while (this.pendingAudioBuffers.length) {
      const audioBuffer = this.pendingAudioBuffers.shift();
      this.scheduleAudioBufferSource(audioBuffer, {
        fadeIn: !continuesQueuedAudio
      });
      continuesQueuedAudio = true;
    }
    this.firstPendingAudioAt = 0;
  }

  scheduleAudioBufferSource(audioBuffer, { fadeIn }) {
    if (!this.audioContext) {
      return;
    }
    const source = this.audioContext.createBufferSource();
    const envelope = this.audioContext.createGain();
    source.buffer = audioBuffer;
    source.connect(envelope);
    envelope.connect(this.assistantGain || this.audioContext.destination);
    const currentTime = this.audioContext.currentTime;
    const startAt = fadeIn
      ? Math.max(currentTime + GEMINI_PLAYBACK_LEAD_SECONDS, this.playbackTime)
      : Math.max(currentTime, this.playbackTime);
    const stopAt = startAt + audioBuffer.duration;
    if (fadeIn) {
      envelope.gain.setValueAtTime(0.0001, startAt);
      envelope.gain.linearRampToValueAtTime(1, startAt + Math.min(GEMINI_PLAYBACK_RAMP_SECONDS, audioBuffer.duration / 2));
      this.onEvent({ type: "aura.audio.playback_buffer_refilled" });
    } else {
      envelope.gain.setValueAtTime(1, startAt);
    }
    source.start(startAt);
    this.audioSources.add(source);
    const queuedPlaybackMs = Math.max(0, stopAt - currentTime) * 1000;
    this.micSuppressedUntil = Math.max(this.micSuppressedUntil, performance.now() + queuedPlaybackMs + GEMINI_MIC_SUPPRESSION_TAIL_MS);
    source.addEventListener("ended", () => {
      this.audioSources.delete(source);
      envelope.disconnect();
    });
    this.playbackTime = stopAt;
  }

  clearPendingGeminiAudio() {
    if (this.playbackTimer) {
      clearTimeout(this.playbackTimer);
      this.playbackTimer = null;
    }
    this.pendingAudioBuffers = [];
    this.firstPendingAudioAt = 0;
  }

  shouldSuppressMicrophoneForPlayback() {
    if (!this.audioSources.size && performance.now() >= this.micSuppressedUntil) {
      return false;
    }
    const now = performance.now();
    if (now - this.lastMicSuppressionEventAt > 1000) {
      this.lastMicSuppressionEventAt = now;
      this.onEvent({ type: "aura.audio.capture_suppressed_during_playback" });
    }
    return true;
  }

  textWithAttachmentContext(text, attachments) {
    const directive = voiceDirectiveForText(text);
    const base = directive ? `${text}\n\n${directive}` : text;
    if (!attachments.length) {
      return base;
    }
    const summary = attachments.map((attachment) => `${attachment.kind}: ${attachment.name}`).join("; ");
    return `${base}\n\nAnexos enviados: ${summary}`;
  }

  handleUserSpeech(text) {
    if (isAssistantSpeaking(this.voiceMetrics)) {
      this.interruptAssistant("barge-in");
    }
    this.markVoice("user-input", { text });
  }

  interruptAssistant(reason) {
    if (!isAssistantSpeaking(this.voiceMetrics) && !this.audioSources.size) {
      return;
    }
    this.stopAssistantAudio();
    this.muteAssistantAudioUntil = performance.now() + 500;
    this.markVoice("barge-in");
    this.onEvent({ type: "aura.voice.barge_in", reason });
    if (this.dc?.readyState === "open") {
      this.dc.send(JSON.stringify({ type: "response.cancel" }));
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "interrupt", reason }));
    }
  }

  stopAssistantAudio() {
    this.clearPendingGeminiAudio();
    for (const source of this.audioSources) {
      try {
        source.stop();
      } catch (_) {
        // Source may already have ended.
      }
    }
    this.audioSources.clear();
    if (this.audioContext) {
      this.playbackTime = this.audioContext.currentTime;
    }
  }

  markVoice(type, data = {}) {
    this.voiceMetrics = markVoiceMetric(this.voiceMetrics, { type, ...data });
    this.onVoiceMetrics(this.voiceMetrics);
    this.onEvent({ type: "aura.voice.metrics", metrics: this.voiceMetrics });
  }

  toolCallFromEvent(data) {
    if (data.type === "response.function_call_arguments.done") {
      return {
        callId: data.call_id,
        name: data.name,
        arguments: data.arguments
      };
    }

    if (data.type === "response.output_item.done" && data.item?.type === "function_call") {
      return {
        callId: data.item.call_id,
        name: data.item.name,
        arguments: data.item.arguments
      };
    }

    return null;
  }

  async handleToolCall(call) {
    if (!call.callId || this.handledToolCalls.has(call.callId)) {
      return;
    }
    this.handledToolCalls.add(call.callId);

    const output = await this.onToolCall(call);
    this.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: call.callId,
        output: JSON.stringify(output)
      }
    });
    this.send({ type: "response.create" });
  }
}

async function realtimeApiError(response) {
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json")
    ? await response.json().catch(() => ({}))
    : { message: await response.text().catch(() => "") };
  const apiError = typeof body.error === "object" && body.error ? body.error : body;
  const message = typeof body.error === "string"
    ? [body.error, body.details].filter(Boolean).join(" ")
    : apiError.message || body.details || response.statusText || "Realtime request failed.";
  const error = new Error(message);
  error.status = response.status;
  error.type = apiError.type || null;
  error.code = apiError.code || null;
  return error;
}

async function requestMicrophoneStream() {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: microphoneAudioConstraints()
    });
  } catch (error) {
    if (error?.name === "OverconstrainedError") {
      return navigator.mediaDevices.getUserMedia({ audio: true });
    }
    throw error;
  }
}

function microphoneAudioConstraints() {
  return {
    echoCancellation: { ideal: true },
    noiseSuppression: { ideal: true },
    autoGainControl: { ideal: false },
    channelCount: { ideal: 1 }
  };
}

function downsampleBuffer(input, inputRate, outputRate) {
  if (outputRate === inputRate) {
    return input;
  }
  const ratio = inputRate / outputRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(Math.floor((index + 1) * ratio), input.length);
    let sum = 0;
    for (let sample = start; sample < end; sample += 1) {
      sum += input[sample];
    }
    output[index] = sum / Math.max(1, end - start);
  }
  return output;
}

function floatTo16BitPcm(input) {
  const output = new Int16Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index]));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function base64ToInt16Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Int16Array(bytes.buffer);
}

function mimeRate(mimeType = "") {
  const match = String(mimeType).match(/rate=(\d+)/);
  return match ? Number(match[1]) : null;
}
