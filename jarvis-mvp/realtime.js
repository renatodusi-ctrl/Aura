export class RealtimeClient {
  constructor({ onEvent, onStatus, onTranscript, onToolCall, sessionToken }) {
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.onTranscript = onTranscript;
    this.onToolCall = onToolCall || (async () => ({ ok: false, error: "Tool handler unavailable." }));
    this.sessionToken = sessionToken || (() => "");
    this.pc = null;
    this.dc = null;
    this.ws = null;
    this.stream = null;
    this.audio = null;
    this.audioContext = null;
    this.source = null;
    this.processor = null;
    this.playbackTime = 0;
    this.handledToolCalls = new Set();
  }

  async connect() {
    const status = await fetch("/api/status").then((response) => response.json()).catch(() => ({}));
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

    this.onStatus("requesting-microphone");
    this.pc = new RTCPeerConnection();
    this.audio = document.createElement("audio");
    this.audio.autoplay = true;
    this.audio.playsInline = true;
    this.audio.hidden = true;
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

    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    this.audioContext = new AudioContextCtor();
    await this.audioContext.resume();
    this.playbackTime = this.audioContext.currentTime;
    this.source = this.audioContext.createMediaStreamSource(this.stream);
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (event) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
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
    this.processor.connect(this.audioContext.destination);
  }

  disconnect() {
    this.dc?.close();
    this.ws?.close();
    this.pc?.close();
    this.processor?.disconnect();
    this.source?.disconnect();
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
    this.playbackTime = 0;
    this.handledToolCalls.clear();
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

    if (data.type === "response.audio_transcript.delta" || data.type === "response.output_text.delta") {
      this.onTranscript(data.delta || "");
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
      this.onEvent({ type: "gemini.input_transcription", text: serverContent.inputTranscription.text });
    }
    if (serverContent?.outputTranscription?.text) {
      this.onTranscript(serverContent.outputTranscription.text);
    }
    for (const part of serverContent?.modelTurn?.parts || []) {
      if (part.inlineData?.data) {
        this.playPcmAudio(part.inlineData.data, mimeRate(part.inlineData.mimeType) || 24000);
      }
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
    const pcm = base64ToInt16Array(base64Audio);
    const audioBuffer = this.audioContext.createBuffer(1, pcm.length, sampleRate);
    const channel = audioBuffer.getChannelData(0);
    for (let index = 0; index < pcm.length; index += 1) {
      channel[index] = Math.max(-1, Math.min(1, pcm[index] / 32768));
    }
    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioContext.destination);
    const startAt = Math.max(this.audioContext.currentTime, this.playbackTime);
    source.start(startAt);
    this.playbackTime = startAt + audioBuffer.duration;
  }

  textWithAttachmentContext(text, attachments) {
    if (!attachments.length) {
      return text;
    }
    const summary = attachments.map((attachment) => `${attachment.kind}: ${attachment.name}`).join("; ");
    return `${text}\n\nAnexos enviados: ${summary}`;
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
