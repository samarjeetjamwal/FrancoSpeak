import React, { useState, useEffect, useRef } from "react";
import {
  Languages,
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  Clipboard,
  Check,
  RefreshCw,
  Sparkles,
  PenTool,
  BookOpen,
  Play,
  RotateCcw,
  Sliders,
  HelpCircle,
  CheckCircle2,
  ChevronRight,
  Sparkle
} from "lucide-react";
import {
  TranslationResponse,
  PronunciationResponse,
  RefineWritingResponse,
  PracticePhrase,
  LanguageCode
} from "./types";

export default function App() {
  // Application Modes: 'translate' | 'speak' | 'write' | 'live'
  const [activeTab, setActiveTab] = useState<"translate" | "speak" | "write" | "live">("translate");

  // Global Speech Synthesis configuration
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoiceName, setSelectedVoiceName] = useState<string>("");
  const [speechRate, setSpeechRate] = useState<number>(0.9); // speed rate
  const [isCurrentlySynthesizing, setIsCurrentlySynthesizing] = useState<boolean>(false);

  // Common UI State
  const [loading, setLoading] = useState<boolean>(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [copiedText, setCopiedText] = useState<boolean>(false);

  // 4. Live Voice Conversation States
  const [liveTabStatus, setLiveTabStatus] = useState<"disconnected" | "connecting" | "live" | "error">("disconnected");
  const [liveMessages, setLiveMessages] = useState<{ sender: "user" | "model"; text: string; timestamp: Date }[]>([]);
  const [liveVoice, setLiveVoice] = useState<string>("Aoede");
  const [isLiveMicActive, setIsLiveMicActive] = useState<boolean>(true);
  const [liveInstructions, setLiveInstructions] = useState<string>(
    "You are Seraphina, an elite, charming bilingual tutor who helps users practice conversations in both English and French. Speak immediately and concisely. Give brief, natural conversational replies (under 2 sentences), making corrections gently if needed."
  );

  const liveWsRef = useRef<WebSocket | null>(null);
  const liveRecorderRef = useRef<any>(null);
  const playbackContextRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef<number>(0);
  const activeSourceNodesRef = useRef<AudioBufferSourceNode[]>([]);
  const liveChatEndRef = useRef<HTMLDivElement | null>(null);

  // Helper: Convert ArrayBuffer to Base64
  const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  };

  // Helper: Stop current live playback nodes immediately
  const stopLivePlayback = () => {
    activeSourceNodesRef.current.forEach((node) => {
      try {
        node.stop();
      } catch (e) {
        // already stopped or finished
      }
    });
    activeSourceNodesRef.current = [];
    nextPlayTimeRef.current = 0;
  };

  // Helper: Play incoming raw 24kHz Int16 base64 PCM audio chunk seamlessly
  const playLivePcmChunk = (base64Data: string) => {
    try {
      if (!playbackContextRef.current) {
        playbackContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      const ctx = playbackContextRef.current;
      if (ctx.state === "suspended") {
        ctx.resume();
      }

      const binaryString = window.atob(base64Data);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      const int16Array = new Int16Array(bytes.buffer);
      const float32Array = new Float32Array(int16Array.length);
      for (let i = 0; i < int16Array.length; i++) {
        float32Array[i] = int16Array[i] / 32768.0;
      }

      const audioBuffer = ctx.createBuffer(1, float32Array.length, 24000);
      audioBuffer.copyToChannel(float32Array, 0);

      const sourceNode = ctx.createBufferSource();
      sourceNode.buffer = audioBuffer;
      sourceNode.connect(ctx.destination);

      activeSourceNodesRef.current.push(sourceNode);
      sourceNode.onended = () => {
        activeSourceNodesRef.current = activeSourceNodesRef.current.filter((n) => n !== sourceNode);
      };

      let startPlayTime = nextPlayTimeRef.current;
      if (startPlayTime < ctx.currentTime) {
        startPlayTime = ctx.currentTime;
      }

      sourceNode.start(startPlayTime);
      nextPlayTimeRef.current = startPlayTime + audioBuffer.duration;
    } catch (e) {
      console.error("PCM Chunk buffering/playback failed:", e);
    }
  };

  // Helper: Start raw 16kHz audio mic recorder
  const startLiveAudioInput = async (ws: WebSocket) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(4096, 1, 1);

      processor.onaudioprocess = (e) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        // Check local mic toggle (live muted check)
        if (!isLiveMicActive) return;

        const inputData = e.inputBuffer.getChannelData(0);
        const l = inputData.length;
        const pcmBuffer = new Int16Array(l);
        for (let i = 0; i < l; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          pcmBuffer[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        const base64Audio = arrayBufferToBase64(pcmBuffer.buffer);
        ws.send(
          JSON.stringify({
            realtimeInput: {
              mediaChunks: [
                {
                  mimeType: "audio/pcm;rate=16000",
                  data: base64Audio
                }
              ]
            }
          })
        );
      };

      source.connect(processor);
      processor.connect(ctx.destination);

      liveRecorderRef.current = {
        mediaStream: stream,
        audioContext: ctx,
        sourceNode: source,
        processorNode: processor
      };
    } catch (err) {
      console.error("Failed to map microphone input:", err);
      setErrorText("Missing microphone accessibility permissions for real-time conversation. Please update device configurations.");
    }
  };

  // Helper: Stop active local audio recording stream completely
  const stopLiveAudioInput = () => {
    if (liveRecorderRef.current) {
      try {
        const { mediaStream, audioContext, sourceNode, processorNode } = liveRecorderRef.current;
        if (processorNode) processorNode.disconnect();
        if (sourceNode) sourceNode.disconnect();
        if (mediaStream) {
          mediaStream.getTracks().forEach((track: any) => track.stop());
        }
        if (audioContext && audioContext.state !== "closed") {
          audioContext.close();
        }
      } catch (e) {
        console.warn("Exception closing microphone pipes:", e);
      }
      liveRecorderRef.current = null;
    }
  };

  // Voice chat scroll helper
  useEffect(() => {
    if (liveChatEndRef.current) {
      liveChatEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [liveMessages]);

  const addLiveStatusLog = (msg: string) => {
    setLiveMessages((prev) => [
      ...prev,
      { sender: "model", text: `[System]: ${msg}`, timestamp: new Date() }
    ]);
  };

  const appendLiveChatEntry = (sender: "user" | "model", text: string) => {
    setLiveMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.sender === sender && last.text === text) {
        return prev;
      }
      return [...prev, { sender, text, timestamp: new Date() }];
    });
  };

  // WebSocket Session connection starter/terminator
  const toggleLiveVoiceSession = () => {
    if (liveTabStatus === "live" || liveTabStatus === "connecting") {
      // Gracefully terminate active session
      if (liveWsRef.current) {
        liveWsRef.current.close();
      }
      stopLiveAudioInput();
      stopLivePlayback();
      setLiveTabStatus("disconnected");
      addLiveStatusLog("Voice workspace session closed successfully.");
    } else {
      setLiveTabStatus("connecting");
      setErrorText(null);
      stopLivePlayback();

      try {
        const host = window.location.host;
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const socketUrl = `${protocol}//${host}/api/live`;

        console.log(`Connecting Live API upstream proxy to: ${socketUrl}`);
        const ws = new WebSocket(socketUrl);
        liveWsRef.current = ws;

        ws.onopen = () => {
          console.log("[Client] Live WebSocket created successfully");
          setLiveTabStatus("live");

          // Send setup specification JSON with voice Name and system prompts
          const setupMsg = {
            setup: {
              model: "models/gemini-3.1-flash-live-preview",
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: {
                      voiceName: liveVoice
                    }
                  }
                }
              },
              systemInstruction: {
                parts: [{ text: liveInstructions }]
              }
            }
          };
          ws.send(JSON.stringify(setupMsg));
          addLiveStatusLog("Live session initiated! Say 'Hello' or 'Bonjour' to test speaking. Speak clearly into your microphone.");

          startLiveAudioInput(ws);
        };

        ws.onmessage = (event) => {
          try {
            if (typeof event.data !== "string") return;
            const data = JSON.parse(event.data);

            // 1. Handle upstream live audio frames
            if (data.serverContent?.modelTurn?.parts) {
              const parts = data.serverContent.modelTurn.parts;
              parts.forEach((part: any) => {
                if (part.inlineData?.data) {
                  playLivePcmChunk(part.inlineData.data);
                }
                if (part.text && part.text.trim()) {
                  appendLiveChatEntry("model", part.text);
                }
              });
            }

            // 2. Map immediate transcription of user voice input
            if (data.serverContent?.userTurn?.parts) {
              data.serverContent.userTurn.parts.forEach((part: any) => {
                if (part.text && part.text.trim()) {
                  appendLiveChatEntry("user", part.text);
                  stopLivePlayback(); // immediate interrupt
                }
              });
            }

            // 3. Handle live disruption signal
            if (data.interrupted) {
              console.log("[Client] Local speaking interrupted upstream model playback.");
              stopLivePlayback();
            }

          } catch (e) {
            console.error("Browser websocket deserialization issue:", e);
          }
        };

        ws.onerror = (err) => {
          console.error("Live Socket experienced error:", err);
          setLiveTabStatus("error");
          setErrorText("Failed to establish real-time voice link. Verify your internet connection and API credential activation.");
        };

        ws.onclose = () => {
          console.log("Upstream Live socket connection closed.");
          stopLiveAudioInput();
          stopLivePlayback();
          setLiveTabStatus("disconnected");
        };

      } catch (err: any) {
        console.error("Live socket error:", err);
        setLiveTabStatus("error");
        setErrorText(err.message || "Unable to spin up voice WebSocket client.");
      }
    }
  };

  // Clean-up refs on component unmount
  useEffect(() => {
    return () => {
      if (liveWsRef.current) {
        liveWsRef.current.close();
      }
      stopLiveAudioInput();
      stopLivePlayback();
    };
  }, []);

  // 1. Translation Hub States
  const [sourceText, setSourceText] = useState<string>("");
  const [fromLang, setFromLang] = useState<LanguageCode>("en");
  const [toLang, setToLang] = useState<LanguageCode>("fr");
  const [translationResult, setTranslationResult] = useState<TranslationResponse | null>(null);
  const [autoSpeakTranslation, setAutoSpeakTranslation] = useState<boolean>(true);

  // 2. Pronunciation & Listening States
  const [phrasesTheme, setPhrasesTheme] = useState<string>("conversational basics");
  const [phrasesDifficulty, setPhrasesDifficulty] = useState<"beginner" | "intermediate" | "advanced">("beginner");
  const [practicePhrases, setPracticePhrases] = useState<PracticePhrase[]>([
    {
      english: "Welcome to our beautiful interactive classroom!",
      french: "Bienvenue dans notre belle salle de classe interactive !",
      context: "Welcoming someone with deep friendliness",
      pronunciationFrench: "byen-ven-oo dahn no-truh bel sal duh klass in-ter-ak-teev",
      pronunciationEnglish: "wel-kuhm too awr byoo-tih-fuhl in-ter-ak-tiv klas-room"
    }
  ]);
  const [activePhraseIndex, setActivePhraseIndex] = useState<number>(0);
  const [spokenAttemptText, setSpokenAttemptText] = useState<string>("");
  const [pronunciationResult, setPronunciationResult] = useState<PronunciationResponse | null>(null);

  // 3. Written Workshop States
  const [writingInput, setWritingInput] = useState<string>("");
  const [writingLang, setWritingLang] = useState<LanguageCode>("fr");
  const [writingRefinement, setWritingRefinement] = useState<RefineWritingResponse | null>(null);

  // Microphone Speech Recognition States
  const [isListening, setIsListening] = useState<boolean>(false);
  const [micTargetInput, setMicTargetInput] = useState<"sourceTranslate" | "spokenAttempt" | "writing">("sourceTranslate");
  
  // Custom suggestion helpers
  const starterPrompts = {
    translate: [
      { text: "Where can I find the nearest bakery for fresh baguettes?", lang: "en" },
      { text: "Le soleil brille aujourd'hui sur les collines de Provence.", lang: "fr" },
      { text: "Could you tell me how to get to the Louvre museum, please?", lang: "en" }
    ],
    writing: [
      { text: "Je aimerais voyager à Paris la semaine prochaine pour voir mon ami.", lang: "fr" }, // intentionally slightly incorrect
      { text: "I wants to learning French because it is a very beautiful language.", lang: "en" } // intentionally incorrect
    ]
  };

  // Browser SpeechSynthesis initialization
  useEffect(() => {
    const loadVoices = () => {
      const availVoices = window.speechSynthesis.getVoices();
      setVoices(availVoices);
      
      // Auto-pick a suitable default voice based on languages
      if (availVoices.length > 0) {
        let defaultChoice = availVoices.find(v => v.lang.startsWith("fr-FR")) ||
                            availVoices.find(v => v.lang.startsWith("en-US")) ||
                            availVoices[0];
        setSelectedVoiceName(defaultChoice.name);
      }
    };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
    return () => {
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, []);

  // Web Speech API - Speech Recognition Setup
  const recognitionRef = useRef<any>(null);

  const startSpeechRecognition = (target: "sourceTranslate" | "spokenAttempt" | "writing", targetLang: LanguageCode) => {
    setErrorText(null);
    setMicTargetInput(target);

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setErrorText("Your browser does not support Web Speech Recognition. Please try using Google Chrome, Edge, or Safari.");
      return;
    }

    try {
      if (recognitionRef.current) {
        recognitionRef.current.abort();
      }

      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.lang = targetLang === "fr" ? "fr-FR" : "en-US";
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;

      recognition.onstart = () => {
        setIsListening(true);
      };

      recognition.onerror = (event: any) => {
        console.error("Speech recognition error:", event.error);
        if (event.error === "not-allowed") {
          setErrorText("Microphone permission was denied. Please allow microphone access in your browser settings.");
        } else if (event.error === "no-speech") {
          setErrorText("No speaking detected. Please try talking more clearly or checking your microphone volume settings.");
        } else {
          setErrorText(`Speech recognition error: ${event.error}. Please try again.`);
        }
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognition.onresult = (event: any) => {
        const resultText = event.results[0][0].transcript;
        if (target === "sourceTranslate") {
          setSourceText(resultText);
          const activeToLang = targetLang === "en" ? "fr" : "en";
          handleTranslateText(resultText, targetLang, activeToLang);
        } else if (target === "spokenAttempt") {
          setSpokenAttemptText(resultText);
        } else if (target === "writing") {
          setWritingInput(resultText);
        }
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch (e: any) {
      console.error(e);
      setErrorText("Error starting Speech Recognition engine.");
      setIsListening(false);
    }
  };

  const stopSpeechRecognition = () => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
    }
    setIsListening(false);
  };

  // Speaks utilizing SpeechSynthesis
  const speakText = (text: string, targetLang: "en" | "fr") => {
    if (!text) return;
    
    // Stop any existing spoken utterances
    window.speechSynthesis.cancel();
    
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      
      // Attempt setting selected voice or fall back to language match
      const selectedVoice = voices.find(v => v.name === selectedVoiceName);
      if (selectedVoice) {
        utterance.voice = selectedVoice;
      } else {
        utterance.lang = targetLang === "fr" ? "fr-FR" : "en-US";
      }

      utterance.rate = speechRate;
      
      utterance.onstart = () => setIsCurrentlySynthesizing(true);
      utterance.onend = () => setIsCurrentlySynthesizing(false);
      utterance.onerror = () => setIsCurrentlySynthesizing(false);

      window.speechSynthesis.speak(utterance);
    } catch (err) {
      console.error("Speech Synthesis Error:", err);
    }
  };

  const stopSpeechSynthesis = () => {
    window.speechSynthesis.cancel();
    setIsCurrentlySynthesizing(false);
  };

  // 1. Trigger API Translation
  const handleTranslateText = async (textToTranslate: string, fromCode: LanguageCode, toCode: LanguageCode) => {
    if (!textToTranslate.trim()) return;

    setLoading(true);
    setErrorText(null);
    setTranslationResult(null);

    try {
      const response = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: textToTranslate, fromLang: fromCode, toLang: toCode })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to fetch translation from backend");
      }
      setTranslationResult(data);

      // Instantly pronounce translation if Auto-Speak is enabled
      if (autoSpeakTranslation) {
        speakText(data.translation, toCode);
      }
    } catch (err: any) {
      console.error(err);
      setErrorText(err.message || "An unexpected translation error occurred. Ensure your API key is configured.");
    } finally {
      setLoading(false);
    }
  };

  const handleTranslate = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    await handleTranslateText(sourceText, fromLang, toLang);
  };

  // Helper to swap translator languages
  const swapLanguages = () => {
    const tempLang = fromLang;
    setFromLang(toLang);
    setToLang(tempLang);
    setSourceText(translationResult?.translation || "");
    setTranslationResult(null);
  };

  // 2. Fetch Thematic Phrases
  const handleGeneratePhrases = async () => {
    setLoading(true);
    setErrorText(null);
    setPronunciationResult(null);
    setSpokenAttemptText("");

    try {
      const response = await fetch("/api/get-phrases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: phrasesTheme, difficulty: phrasesDifficulty })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed seeking phonetic practice phrases");
      }

      if (data && data.length > 0) {
        setPracticePhrases(data);
        setActivePhraseIndex(0);
      }
    } catch (err: any) {
      console.error(err);
      setErrorText(err.message || "Could not retrieve phrases list. Ensure your Gemini API key is valid.");
    } finally {
      setLoading(false);
    }
  };

  // Evaluate user pronunciation score & clarity feedback
  const handleAnalyzePronunciation = async () => {
    const currentPhrase = practicePhrases[activePhraseIndex];
    if (!currentPhrase) return;
    if (!spokenAttemptText.trim()) {
      setErrorText("Please write or record your spoken attempt first so we can analyze it!");
      return;
    }

    setLoading(true);
    setErrorText(null);
    setPronunciationResult(null);

    const targetText = phrasesDifficulty === "beginner" ? currentPhrase.french : currentPhrase.french; // Evaluates french or english based on selection
    // Let's analyze based on which language they are practicing!
    // If the beginner wants to practice English pronunciation of French or French pronunciation of English:
    // Let's evaluate French pronunciation as target by default or let user choose.
    // Let's check target text. We have both English and French! Let's choose the French version as target.
    
    try {
      const response = await fetch("/api/analyze-pronunciation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetText: currentPhrase.french, // target text is French
          spokenText: spokenAttemptText,
          lang: "fr" // target is French learning
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed assessing spoken pronunciation accuracy.");
      }
      setPronunciationResult(data);
    } catch (err: any) {
      console.error(err);
      setErrorText(err.message || "Failed reviewing pronunciation attempt. Ensure browser/database access is functional.");
    } finally {
      setLoading(false);
    }
  };

  // 3. Polishes writing inputs
  const handleCheckWriting = async () => {
    if (!writingInput.trim()) return;

    setLoading(true);
    setErrorText(null);
    setWritingRefinement(null);

    try {
      const response = await fetch("/api/refine-writing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: writingInput, lang: writingLang })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed checking your written inputs.");
      }
      setWritingRefinement(data);
    } catch (err: any) {
      console.error(err);
      setErrorText(err.message || "Failed checking writing composition. Please check internet connections.");
    } finally {
      setLoading(false);
    }
  };

  // Quick clipboard utility
  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(true);
    setTimeout(() => setCopiedText(false), 2000);
  };

  return (
    <div className="min-h-screen bg-cream-earth text-slate-800 font-sans antialiased pb-12">
      {/* Header and Branding section */}
      <header className="px-6 md:px-10 py-6">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full olive-bg flex items-center justify-center shadow-md">
              <Languages className="w-5 h-5 text-white" />
            </div>
            <div>
              <span className="font-serif text-3.5xl font-semibold tracking-tight text-slate-[#5A5A40] block leading-none">FrancoSpeak</span>
              <span className="text-[10px] uppercase font-mono tracking-widest text-slate-500 font-bold block mt-1">English-French Translation & Speech Sandbox</span>
            </div>
          </div>

          {/* Quick Speech Config Panel */}
          <div className="flex flex-wrap items-center gap-3 bg-white/60 backdrop-blur-md border border-white/40 p-2.5 rounded-2xl shadow-sm">
            <div className="flex items-center gap-1.5 text-xs text-[#5A5A40] font-bold">
              <Sliders className="w-3.5 h-3.5" />
              <span>Voice Speed:</span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min="0.5"
                max="1.5"
                step="0.1"
                value={speechRate}
                onChange={(e) => setSpeechRate(parseFloat(e.target.value))}
                className="w-16 sm:w-24 h-1 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-[#5A5A40]"
              />
              <span className="text-[10px] font-mono bg-white border border-slate-200 px-1.5 py-0.5 rounded text-slate-600">
                {speechRate}x
              </span>
            </div>

            <div className="h-4 w-px bg-slate-300 hidden sm:block"></div>

            {/* Voice Dropdown */}
            <select
              value={selectedVoiceName}
              onChange={(e) => setSelectedVoiceName(e.target.value)}
              className="text-xs bg-white border border-slate-200 text-slate-600 py-1 px-2 rounded-lg cursor-pointer max-w-[140px] truncate focus:outline-none focus:ring-1 focus:ring-olive-deep"
            >
              <option value="">Default Language Voice</option>
              {voices.map((voice) => (
                <option key={voice.name} value={voice.name}>
                  {voice.name} ({voice.lang})
                </option>
              ))}
            </select>
          </div>
        </div>
      </header>

      {/* Main Sandbox Workspace */}
      <main className="max-w-6xl mx-auto px-4 py-4">
        
        {/* TAB NAVIGATION CONTROLLERS */}
        <div className="flex p-1 bg-slate-200/50 rounded-full mb-8 max-w-xl sm:max-w-2xl mx-auto shadow-inner border border-slate-200/30">
          <button
            onClick={() => setActiveTab("translate")}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-xs sm:text-sm font-semibold rounded-full transition-all duration-200 ${
              activeTab === "translate"
                ? "olive-bg text-white shadow-md scale-[1.02]"
                : "text-[#5A5A40] hover:text-slate-900"
            }`}
          >
            <Languages className="w-4 h-4" />
            Translate Hub
          </button>
          <button
            onClick={() => {
              setActiveTab("speak");
              // Load practice phrases if they only have the default sample
              if (practicePhrases.length === 1) {
                handleGeneratePhrases();
              }
            }}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-xs sm:text-sm font-semibold rounded-full transition-all duration-200 ${
              activeTab === "speak"
                ? "olive-bg text-white shadow-md scale-[1.02]"
                : "text-[#5A5A40] hover:text-slate-900"
            }`}
          >
            <BookOpen className="w-4 h-4" />
            Speak Practice
          </button>
          <button
            onClick={() => setActiveTab("write")}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-xs sm:text-sm font-semibold rounded-full transition-all duration-200 ${
              activeTab === "write"
                ? "olive-bg text-white shadow-md scale-[1.02]"
                : "text-[#5A5A40] hover:text-slate-900"
            }`}
          >
            <PenTool className="w-4 h-4" />
            Write & Refine
          </button>
          <button
            onClick={() => setActiveTab("live")}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-xs sm:text-sm font-semibold rounded-full transition-all duration-200 ${
              activeTab === "live"
                ? "olive-bg text-white shadow-md scale-[1.02]"
                : "text-[#5A5A40] hover:text-slate-900"
            }`}
          >
            <Volume2 className="w-4 h-4" />
            Live Tutor
          </button>
        </div>

        {/* Global Loading Spinner for background evaluations */}
        {loading && (
          <div className="bg-[#5A5A40]/10 border border-[#5A5A40]/20 text-[#5A5A40] rounded-2xl p-4 mb-6 flex items-center gap-3 animate-pulse">
            <Sparkles className="w-5 h-5 text-olive-deep animate-spin" />
            <span className="text-sm font-semibold">Bilingual tutor is evaluating & generating ideas...</span>
          </div>
        )}

        {/* Common Error Banner */}
        {errorText && (
          <div className="bg-red-50 border border-red-200 text-red-800 rounded-2xl p-4 mb-6 flex items-start gap-3">
            <div className="bg-red-100 text-red-700 p-1.5 rounded-lg mt-0.5">
              <span className="font-bold text-sm">!</span>
            </div>
            <div className="flex-1">
              <h4 className="text-sm font-semibold text-red-900 font-serif">Application Insight Required</h4>
              <p className="text-xs mt-0.5 text-red-700 font-sans">{errorText}</p>
            </div>
            <button
              onClick={() => setErrorText(null)}
              className="text-xs text-red-500 hover:text-red-700 font-medium px-2.5 py-1 bg-white border border-red-100 rounded-lg"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* TAB 1: INTERACTIVE TRANSLATION HUB */}
        {activeTab === "translate" && (
          <div className="space-y-6">
            {/* Real-time speech translation setting status bar */}
            <div className="glass rounded-[30px] p-5 flex flex-col sm:flex-row items-center justify-between gap-4 shadow-sm animate-fade-in border border-slate-200/20">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-[#5A5A40]/10 flex items-center justify-center text-[#5A5A40] shrink-0">
                  <Mic className="w-5 h-5 animate-pulse" />
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-slate-800">Real-Time Spoken Translation Mode</h4>
                  <p className="text-[11px] text-slate-500 font-sans">Click the microphone to dictate. FrancoSpeak will translate and speak the result out loud instantly.</p>
                </div>
              </div>
              <button
                onClick={() => setAutoSpeakTranslation(!autoSpeakTranslation)}
                className={`flex items-center gap-2 py-2 px-4 rounded-full text-xs font-bold transition-all shadow-sm cursor-pointer select-none ${
                  autoSpeakTranslation 
                    ? "bg-[#5A5A40] text-white hover:bg-slate-800" 
                    : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"
                }`}
                title="Toggle automatic voice read out of generated translation"
              >
                <Volume2 className="w-3.5 h-3.5" />
                <span>Auto-Speak:</span>
                <span className="uppercase text-[9px] tracking-wider bg-white/20 px-1.5 py-0.5 rounded">
                  {autoSpeakTranslation ? "ENABLED" : "DISABLED"}
                </span>
              </button>
            </div>

            <div className="overflow-hidden">
              {/* Translation Panels split */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Source Input Column - GLASS styling */}
                <div className="glass rounded-[40px] p-8 flex flex-col relative space-y-4">
                  <div className="flex items-center justify-between pb-3 border-b border-slate-200/40">
                    <div className="sans text-[10px] uppercase tracking-widest opacity-50 font-bold">
                      {fromLang === "en" ? "English / Source" : "Français / Source"}
                    </div>
                    <div className="flex items-center gap-2">
                      <select
                        value={fromLang}
                        onChange={(e) => {
                          const selected = e.target.value as LanguageCode;
                          setFromLang(selected);
                          setToLang(selected === "en" ? "fr" : "en");
                        }}
                        className="text-xs bg-white/70 border border-slate-200 text-slate-700 py-1 px-2.5 rounded-lg font-medium shadow-sm"
                      >
                        <option value="en">🇺🇸 English</option>
                        <option value="fr">🇫🇷 Français</option>
                      </select>
                      {sourceText && (
                        <button
                          onClick={() => speakText(sourceText, fromLang)}
                          className="p-1.5 bg-white/90 hover:bg-white text-[#5A5A40] rounded-full transition-all shadow-sm"
                          title="Pronounce input text"
                        >
                          <Volume2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>

                  <textarea
                    rows={4}
                    value={sourceText}
                    onChange={(e) => setSourceText(e.target.value)}
                    placeholder={
                      fromLang === "en" ? "Enter text to translate..." : "Saisissez du texte à traduire..."
                    }
                    className="bg-transparent flex-1 resize-none font-serif text-3xl focus:outline-none placeholder-slate-400 text-slate-900 border-none outline-none mt-2"
                  />

                  {/* Starter Suggestions */}
                  <div className="flex flex-wrap items-center gap-2 pt-2">
                    <span className="text-[10px] text-slate-500 uppercase tracking-wider font-extrabold">Starter ideas:</span>
                    {starterPrompts.translate
                      .filter((p) => p.lang === fromLang)
                      .map((p, i) => (
                        <button
                          key={i}
                          onClick={() => setSourceText(p.text)}
                          className="text-[11px] bg-white/70 hover:bg-white text-[#5A5A40] py-1 px-2.5 rounded-full border border-slate-200 font-medium transition-all"
                        >
                          {p.text}
                        </button>
                      ))}
                  </div>

                  {/* Submit Button & mic */}
                  <div className="flex items-center justify-between pt-4 border-t border-slate-200/40">
                    <div className="flex items-center gap-2">
                      {isListening && micTargetInput === "sourceTranslate" ? (
                        <button
                          onClick={stopSpeechRecognition}
                          className="w-12 h-12 rounded-full bg-red-600 text-white flex items-center justify-center shadow-md animate-pulse"
                        >
                          <MicOff className="w-5 h-5 animate-bounce" />
                        </button>
                      ) : (
                        <button
                          onClick={() => startSpeechRecognition("sourceTranslate", fromLang)}
                          className="w-12 h-12 rounded-full border border-slate-300 hover:border-olive-deep text-slate-600 hover:text-slate-900 flex items-center justify-center transition-all bg-white/60"
                          title="Speak source text"
                        >
                          <Mic className="w-5 h-5" />
                        </button>
                      )}
                      <button
                        onClick={swapLanguages}
                        className="w-12 h-12 rounded-full border border-slate-300 hover:border-olive-deep text-slate-600 hover:text-slate-900 flex items-center justify-center transition-all bg-white/60"
                        title="Swap languages"
                      >
                        <RefreshCw className="w-5 h-5" />
                      </button>
                    </div>

                    <button
                      onClick={() => handleTranslate()}
                      disabled={loading || !sourceText.trim()}
                      className="px-6 py-2.5 rounded-full bg-[#5A5A40] hover:bg-slate-800 text-white text-sm font-semibold transition-all duration-150 disabled:bg-slate-300"
                    >
                      Translate
                    </button>
                  </div>
                </div>

                {/* Translation Target Column - OLIVE color element styled matching Design */}
                <div className="olive-bg rounded-[40px] p-8 flex flex-col text-white shadow-xl space-y-4 justify-between min-h-[300px]">
                  <div>
                    <div className="flex items-center justify-between pb-3 border-b border-white/10">
                      <div className="sans text-[10px] uppercase tracking-widest opacity-60 font-bold">
                        {toLang === "fr" ? "Français / Traduction" : "English / Translation"}
                      </div>
                      
                      {translationResult && (
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => speakText(translationResult.translation, toLang)}
                            className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-all"
                            title="Listen pronunciation"
                          >
                            <Volume2 className="w-4.5 h-4.5" />
                          </button>
                          <button
                            onClick={() => copyToClipboard(translationResult.translation)}
                            className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-all"
                            title="Copy translation"
                          >
                            {copiedText ? <Check className="w-4.5 h-4.5 text-emerald-300" /> : <Clipboard className="w-4.5 h-4.5" />}
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="mt-4">
                      {translationResult ? (
                        <p className="font-serif text-3xl leading-relaxed tracking-wide text-white">
                          {translationResult.translation}
                        </p>
                      ) : (
                        <div className="flex flex-col items-center justify-center text-white/50 h-36 space-y-3">
                          <Languages className="w-12 h-12 stroke-[1] text-white/30" />
                          <span className="text-sm font-serif italic">Your translation outputs will emerge gracefully here...</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {translationResult && (
                    <div className="bg-white/10 rounded-2xl p-4 border border-white/10">
                      <span className="text-[9px] font-bold text-white/60 uppercase tracking-widest block mb-1">
                        Pronunciation guide
                      </span>
                      <p className="text-sm font-mono text-white tracking-wider">
                        {translationResult.phonetics}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Translation Footnotes and Linguistic Breakdown */}
            {translationResult && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-6 animate-fade-in">
                {/* Vocabulary Breakdown Notes */}
                <div className="glass rounded-[35px] p-6 shadow-sm">
                  <h4 className="font-serif text-[18px] font-bold text-slate-800 mb-4 flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full clay-bg shrink-0"></span> Key Vocabulary Footnotes
                  </h4>
                  <ul className="space-y-3">
                    {translationResult.notes.map((note, index) => (
                      <li key={index} className="flex items-start gap-2.5 text-sm text-slate-700 font-sans">
                        <span className="text-[#5A5A40] mt-1">•</span>
                        <span>{note}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Cultural and Grammar Rules Breakdown */}
                <div className="glass rounded-[35px] p-6 shadow-sm">
                  <h4 className="font-serif text-[18px] font-bold text-slate-800 mb-4 flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full olive-bg shrink-0"></span> Grammatical Insight
                  </h4>
                  <div className="bg-white/50 border border-slate-200/40 rounded-2xl p-4 text-sm text-slate-700 leading-relaxed font-sans">
                    <p>{translationResult.grammar}</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 2: SPEECH PRONOUNCE & LISTEN COMPREHENSION PRACTICE */}
        {activeTab === "speak" && (
          <div className="space-y-6 animate-fade-in">
            {/* Phrase setup and filters */}
            <div className="glass rounded-[40px] p-8 shadow-sm">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6 pb-4 border-b border-slate-200/40">
                <div>
                  <h3 className="font-serif text-2xl font-bold text-slate-800">Speaking & Auditory Practice</h3>
                  <p className="text-xs text-slate-500 font-sans mt-1">Pick conversational themes, listen to native phrasing, record, and get AI reviews</p>
                </div>

                {/* Category selectors */}
                <div className="flex flex-wrap items-center gap-2.5">
                  <select
                    value={phrasesTheme}
                    onChange={(e) => setPhrasesTheme(e.target.value)}
                    className="text-xs bg-white border border-slate-200 text-slate-700 font-semibold py-1.5 px-3 rounded-lg shadow-sm"
                  >
                    <option value="conversational basics">🗣️ Conversational Basics</option>
                    <option value="cafes and restaurants">☕ Cafés & Restaurants</option>
                    <option value="travel and accommodations">✈️ Travel & Hotel</option>
                    <option value="work and tech">💻 Work & Technology</option>
                  </select>

                  <select
                    value={phrasesDifficulty}
                    onChange={(e) => setPhrasesDifficulty(e.target.value as any)}
                    className="text-xs bg-white border border-slate-200 text-slate-700 font-semibold py-1.5 px-3 rounded-lg shadow-sm"
                  >
                    <option value="beginner">🟢 Beginner</option>
                    <option value="intermediate">🟡 Intermediate</option>
                    <option value="advanced">🔴 Advanced</option>
                  </select>

                  <button
                    onClick={handleGeneratePhrases}
                    disabled={loading}
                    className="px-4 py-1.5 rounded-lg text-xs bg-olive-deep hover:bg-slate-800 text-white font-semibold transition-all disabled:bg-slate-300"
                  >
                    Generate
                  </button>
                </div>
              </div>

              {/* Slider list of dynamic phrases */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6 border-b border-slate-200/40 pb-5">
                {practicePhrases.map((phrase, idx) => (
                  <button
                    key={idx}
                    onClick={() => {
                      setActivePhraseIndex(idx);
                      // Clear stale scores
                      setPronunciationResult(null);
                      setSpokenAttemptText("");
                    }}
                    className={`p-4 text-left rounded-2xl border text-xs font-semibold transition-all duration-150 ${
                      activePhraseIndex === idx
                        ? "bg-white border-[#5A5A40] text-slate-900 ring-2 ring-[#5A5A40]/10 shadow"
                        : "bg-white/40 border-slate-200 hover:bg-white text-slate-600"
                    }`}
                  >
                    <div className="uppercase tracking-widest text-[9px] font-bold text-[#5A5A40] block mb-1">
                      Phrase {idx + 1}
                    </div>
                    <p className="truncate block font-serif text-sm italic">"{phrase.french}"</p>
                    <p className="text-[11px] text-slate-400 truncate mt-1">{phrase.english}</p>
                  </button>
                ))}
              </div>

              {/* ACTIVE PRACTICE BOARD */}
              {practicePhrases[activePhraseIndex] && (
                <div className="space-y-6">
                  {/* Cards display bilingual version */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* French Target */}
                    <div className="olive-bg text-white p-8 rounded-[35px] shadow-md relative overflow-hidden flex flex-col justify-between min-h-[220px]">
                      <div className="absolute top-0 right-0 p-4 opacity-[0.03]">
                        <Volume2 className="w-24 h-24 stroke-[1]" />
                      </div>

                      <div className="flex items-center justify-between mb-4">
                        <span className="text-[10px] font-bold bg-white/10 text-white py-1 px-2.5 rounded-full uppercase tracking-wider">
                          Practice French
                        </span>
                        <button
                          onClick={() => speakText(practicePhrases[activePhraseIndex].french, "fr")}
                          className="bg-white text-[#5A5A40] hover:bg-slate-200 py-1.5 px-3 rounded-full transition-colors flex items-center gap-1.5 text-xs font-semibold shadow-sm"
                          title="Listen standard French speaker"
                        >
                          <Volume2 className="w-3.5 h-3.5" />
                          <span>Listen Voice</span>
                        </button>
                      </div>

                      <h4 className="font-serif text-3xl font-bold tracking-wide italic leading-relaxed my-2">
                        "{practicePhrases[activePhraseIndex].french}"
                      </h4>

                      <div className="bg-white/10 border border-white/10 rounded-xl p-3 mt-4">
                        <span className="text-[10px] font-bold text-white/70 block mb-0.5">Phonetic speaking guide:</span>
                        <p className="text-sm font-mono text-white/90">
                          {practicePhrases[activePhraseIndex].pronunciationFrench}
                        </p>
                      </div>
                    </div>

                    {/* English translation & context */}
                    <div className="glass p-8 rounded-[35px] shadow-sm flex flex-col justify-between min-h-[220px]">
                      <div>
                        <span className="text-[10px] font-bold bg-[#D48C70]/10 text-[#D48C70] py-1 px-2.5 rounded-full uppercase tracking-wider block w-max mb-4">
                          English Translation
                        </span>
                        <h4 className="font-serif text-2xl font-semibold text-slate-800 leading-relaxed italic">
                          "{practicePhrases[activePhraseIndex].english}"
                        </h4>
                      </div>

                      <div className="border-t border-slate-200/40 pt-4 mt-6 text-xs text-slate-600 font-sans">
                        <strong className="text-slate-800 block mb-1">Context / Situation:</strong>
                        <p>{practicePhrases[activePhraseIndex].context}</p>
                      </div>
                    </div>
                  </div>

                  {/* ACTIVE VOICE RECORDING & SCORING */}
                  <div className="glass rounded-[35px] p-6 shadow-sm">
                    <h4 className="text-xs font-bold text-slate-600 uppercase tracking-widest mb-4 flex items-center gap-2">
                      <Mic className="w-4 h-4 text-[#5A5A40]" /> Speak and record your French attempt
                    </h4>

                    <div className="flex flex-col md:flex-row items-center gap-6">
                      {/* Big Mic Button */}
                      <div className="flex flex-col items-center gap-2">
                        {isListening && micTargetInput === "spokenAttempt" ? (
                          <button
                            onClick={stopSpeechRecognition}
                            className="w-16 h-16 bg-red-600 hover:bg-red-700 text-white rounded-full flex items-center justify-center shadow-lg active:scale-95 transition-all animate-pulse"
                            title="Stop speaking recording"
                          >
                            <MicOff className="w-6 h-6" />
                          </button>
                        ) : (
                          <button
                            onClick={() => startSpeechRecognition("spokenAttempt", "fr")}
                            className="w-16 h-16 bg-[#5A5A40] hover:bg-slate-800 text-white rounded-full flex items-center justify-center shadow-lg hover:shadow-indigo-500/10 active:scale-95 transition-all"
                            title="Record French attempt"
                          >
                            <Mic className="w-6 h-6" />
                          </button>
                        )}
                        <span className="text-[11px] font-bold text-[#5A5A40] tracking-wide mt-1">
                          {isListening && micTargetInput === "spokenAttempt" ? "REC" : "Tap to Speak"}
                        </span>
                      </div>

                      {/* Text Attempt display and Edit option */}
                      <div className="flex-1 w-full space-y-3">
                        <label className="text-xs font-bold text-slate-500 block uppercase tracking-wide">
                          What you spoke (autocorrect / editable):
                        </label>
                        <textarea
                          rows={2}
                          value={spokenAttemptText}
                          onChange={(e) => setSpokenAttemptText(e.target.value)}
                          placeholder="Your spoken transcription will render here. Or you can type to compare accuracy manually..."
                          className="w-full border border-slate-200 bg-white/70 rounded-xl p-3 text-slate-800 font-sans focus:outline-none focus:ring-1 focus:ring-olive-deep text-sm"
                        />
                        
                        <div className="flex justify-end gap-2">
                          <button
                            onClick={() => setSpokenAttemptText("")}
                            className="text-xs border border-slate-200 bg-white text-slate-500 py-1.5 px-3 rounded-lg hover:bg-slate-50 transition-colors flex items-center gap-1"
                          >
                            <RotateCcw className="w-3 h-3" /> Clear Text
                          </button>
                          
                          <button
                            onClick={handleAnalyzePronunciation}
                            disabled={loading || !spokenAttemptText.trim()}
                            className="text-xs font-semibold bg-olive-deep hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400 text-white py-1.5 px-4 rounded-lg shadow-sm transition-all flex items-center gap-1.5 select-none cursor-pointer"
                          >
                            <Sparkles className="w-3.5 h-3.5" /> Analyze Clarity
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* AI Speech evaluation results */}
                  {pronunciationResult && (
                    <div className="glass rounded-[35px] p-8 shadow-sm grid grid-cols-1 md:grid-cols-3 gap-6 animate-fade-in">
                      {/* Evaluation Score Dial */}
                      <div className="flex flex-col items-center justify-center p-4 bg-white/40 rounded-2xl border border-slate-200/50">
                        <span className="text-[10px] font-extrabold text-[#5A5A40] uppercase tracking-widest block mb-4">
                          Clarity Accuracy
                        </span>

                        <div className="relative w-28 h-28 flex items-center justify-center">
                          <svg className="w-full h-full transform -rotate-90">
                            <circle
                              cx="56"
                              cy="56"
                              r="45"
                              stroke="#e2e8f0"
                              strokeWidth="6"
                              fill="transparent"
                            />
                            <circle
                              cx="56"
                              cy="56"
                              r="45"
                              stroke={
                                pronunciationResult.score >= 80 ? "#5A5A40" :
                                pronunciationResult.score >= 50 ? "#D48C70" : "#ef4444"
                              }
                              strokeWidth="7"
                              fill="transparent"
                              strokeDasharray={2 * Math.PI * 45}
                              strokeDashoffset={2 * Math.PI * 45 * (1 - pronunciationResult.score / 100)}
                              className="transition-all duration-500 ease-out"
                            />
                          </svg>
                          <div className="absolute flex flex-col items-center">
                            <span className="text-3xl font-bold text-slate-800">
                              {pronunciationResult.score}%
                            </span>
                            <span className="text-[9px] font-bold text-slate-400 block uppercase">
                              {pronunciationResult.score >= 80 ? "EXCELLENT" :
                               pronunciationResult.score >= 50 ? "DECENT" : "POOR"}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Verbal Feedback and Pointers */}
                      <div className="md:col-span-2 space-y-4 font-sans text-sm">
                        <div>
                          <h5 className="text-[11px] font-extrabold text-[#5A5A40] uppercase tracking-wider mb-1 flex items-center gap-1.5">
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> What went right:
                          </h5>
                          <p className="text-slate-700 leading-relaxed bg-white/40 border border-slate-200/30 p-3 rounded-xl">
                            {pronunciationResult.positivePointers}
                          </p>
                        </div>

                        <div>
                          <h5 className="text-[11px] font-extrabold text-[#D48C70] uppercase tracking-wider mb-1 flex items-center gap-1.5">
                            <Sparkle className="w-3.5 h-3.5" /> Constructor coach tips:
                          </h5>
                          <p className="text-slate-700 leading-relaxed bg-white/40 border border-slate-200/30 p-3 rounded-xl">
                            {pronunciationResult.feedback}
                          </p>
                        </div>

                        {pronunciationResult.mispronouncedWords.length > 0 && (
                          <div>
                            <h5 className="text-[10px] font-bold text-rose-600 uppercase tracking-widest mb-1.5">
                              Double-Practice Focus:
                            </h5>
                            <div className="flex flex-wrap gap-1.5">
                              {pronunciationResult.mispronouncedWords.map((word, idx) => (
                                <span
                                  key={idx}
                                  className="text-xs font-mono font-bold bg-rose-50 text-rose-700 border border-rose-100 py-1 px-3 rounded-lg"
                                >
                                  {word}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 3: INTERACTIVE WRITING WORKSHOP */}
        {activeTab === "write" && (
          <div className="space-y-6 animate-fade-in">
            <div className="glass rounded-[40px] overflow-hidden shadow-sm">
              {/* Header Selector */}
              <div className="px-8 py-5 bg-white/30 border-b border-slate-200/40 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div>
                  <h3 className="font-serif text-2xl font-bold text-slate-800">Bilingual Writing Workshop</h3>
                  <p className="text-xs text-slate-500 font-sans mt-0.5">Practice writing complete paragraphs & essays, analyze grammatical structures & style</p>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-xs text-slate-500 font-bold uppercase tracking-wide font-sans">Check lang:</span>
                  <select
                    value={writingLang}
                    onChange={(e) => setWritingLang(e.target.value as LanguageCode)}
                    className="text-xs bg-white border border-slate-200 text-slate-800 font-semibold py-1.5 px-3 rounded-lg shadow-sm"
                  >
                    <option value="fr">🇫🇷 French / Français</option>
                    <option value="en">🇺🇸 English</option>
                  </select>

                  <div className="h-4 w-px bg-slate-300"></div>

                  {isListening && micTargetInput === "writing" ? (
                    <button
                      onClick={stopSpeechRecognition}
                      className="flex items-center gap-1.5 bg-red-600 hover:bg-red-700 text-white font-medium text-xs py-1.5 px-3 rounded-lg shadow animate-pulse"
                    >
                      <MicOff className="w-3.5 h-3.5" /> Stop
                    </button>
                  ) : (
                    <button
                      onClick={() => startSpeechRecognition("writing", writingLang)}
                      className="flex items-center gap-1.5 bg-white hover:bg-slate-100 text-slate-700 text-xs py-1.5 px-3 rounded-lg border border-slate-200"
                    >
                      <Mic className="w-3.5 h-3.5" /> Dictate
                    </button>
                  )}
                </div>
              </div>

              {/* Main Work split panels */}
              <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-slate-200/40 bg-white/10">
                
                {/* Free Write Panel */}
                <div className="p-8 space-y-4 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between pointer-events-none mb-2">
                      <label className="text-xs font-bold text-slate-500 block uppercase tracking-wide">
                        Draft your paragraphs:
                      </label>
                      {writingInput && (
                        <button
                          onClick={() => speakText(writingInput, writingLang)}
                          className="text-xs text-slate-500 hover:text-slate-800 flex items-center gap-1 pointer-events-auto"
                          title="Pronounce draft out loud"
                        >
                          <Volume2 className="w-3.5 h-3.5" /> Audio Speak
                        </button>
                      )}
                    </div>

                    <textarea
                      rows={7}
                      value={writingInput}
                      onChange={(e) => setWritingInput(e.target.value)}
                      placeholder={
                        writingLang === "fr"
                          ? "Écrivez quelque chose en français ici..."
                          : "Write something in English here..."
                      }
                      className="w-full text-slate-900 placeholder-slate-400 bg-transparent py-2 focus:outline-none text-lg resize-none border-none outline-none font-serif italic"
                    />

                    {/* Creative Writing Suggestions */}
                    <div className="flex flex-wrap items-center gap-2 mt-4 pt-3 border-t border-slate-200/20">
                      <span className="text-[10px] text-slate-500 font-extrabold uppercase tracking-widest block">
                        💡 STARTERS:
                      </span>
                      {starterPrompts.writing
                        .filter((p) => p.lang === writingLang)
                        .map((p, idx) => (
                          <button
                            key={idx}
                            onClick={() => setWritingInput(p.text)}
                            className="text-[11px] bg-white text-slate-600 hover:bg-slate-50 border border-slate-200/80 px-2.5 py-1 rounded-full transition-all"
                          >
                            {p.text}
                          </button>
                        ))}
                    </div>
                  </div>

                  <div className="flex justify-end gap-2 pt-4">
                    <button
                      onClick={() => setWritingInput("")}
                      className="text-xs font-semibold text-slate-600 bg-white border border-slate-200 py-2 px-4 rounded-xl hover:bg-slate-50 transition-all cursor-pointer"
                    >
                      Clear
                    </button>
                    <button
                      onClick={handleCheckWriting}
                      disabled={loading || !writingInput.trim()}
                      className="bg-olive-deep hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400 text-white text-xs font-bold py-2.5 px-5 rounded-xl inline-flex items-center gap-1.5 shadow"
                    >
                      <Sparkles className="w-4 h-4" /> Check Style & Grammar
                    </button>
                  </div>
                </div>

                {/* Polished Native Refinement Output */}
                <div className="p-8 bg-white/20 space-y-4 flex flex-col justify-between min-h-[300px]">
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] font-bold bg-[#D48C70]/10 text-[#D48C70] py-1 px-2.5 rounded-full uppercase tracking-wider block w-max">
                        💫 Polished native edition
                      </span>
                      {writingRefinement && (
                        <button
                          onClick={() => speakText(writingRefinement.refinedText, writingLang)}
                          className="text-xs text-[#5A5A40] hover:text-[#3d3d2a] flex items-center gap-1 font-semibold bg-white border border-slate-200 py-1.5 px-3 rounded-full shadow-sm"
                          title="Listen beautiful Native read out loud"
                        >
                          <Volume2 className="w-3.5 h-3.5" /> Listen Audio
                        </button>
                      )}
                    </div>

                    <div className="mt-4">
                      {writingRefinement ? (
                        <p className="text-slate-800 text-xl font-medium leading-relaxed italic font-serif">
                          "{writingRefinement.refinedText}"
                        </p>
                      ) : (
                        <div className="flex flex-col items-center justify-center text-slate-400 h-36 space-y-2">
                          <PenTool className="w-10 h-10 stroke-[1.2] text-slate-300" />
                          <span className="text-xs font-serif italic text-center text-slate-400 max-w-[220px]">Polishes vocabulary phrasing and provides active stylistic advice...</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

              </div>
            </div>

            {/* Editing and Grammar breakdown list */}
            {writingRefinement && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 animate-fade-in font-sans">
                {/* Corrections block */}
                <div className="glass rounded-[35px] p-6 shadow-sm md:col-span-1">
                  <h4 className="text-xs font-bold text-rose-700 uppercase tracking-widest mb-4 flex items-center gap-1.5">
                    🔧 Structural Corrections
                  </h4>
                  <div className="space-y-3">
                    {writingRefinement.corrections.length > 0 ? (
                      writingRefinement.corrections.map((corr, idx) => (
                        <div
                          key={idx}
                          className="bg-rose-50 text-rose-800 p-3 rounded-xl border border-rose-100/60 text-xs font-semibold"
                        >
                          {corr}
                        </div>
                      ))
                    ) : (
                      <div className="text-emerald-800 bg-emerald-50 p-3 rounded-xl border border-emerald-100/60 text-xs flex items-center gap-1.5 font-semibold">
                        <CheckCircle2 className="w-4 h-4 text-emerald-600" /> Perfect composition! Grammatically rich.
                      </div>
                    )}
                  </div>
                </div>

                {/* Explanations rules block */}
                <div className="glass rounded-[35px] p-6 shadow-sm md:col-span-2">
                  <h4 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-4 flex items-center gap-1.5">
                    📚 Linguistic Rules Explanation
                  </h4>
                  <p className="text-sm text-slate-700 leading-relaxed bg-white/40 border border-slate-200/50 p-4 rounded-2xl font-normal whitespace-pre-line font-sans">
                    {writingRefinement.explanations}
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 4: REAL-TIME MUTUAL LIVE VOICE PRACTICE */}
        {activeTab === "live" && (
          <div className="space-y-6 animate-fade-in">
            <div className="glass rounded-[40px] overflow-hidden shadow-sm">
              {/* Header section */}
              <div className="px-8 py-5 bg-white/30 border-b border-slate-200/40 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div>
                  <h3 className="font-serif text-2xl font-bold text-slate-800">Omni-Channel Voice Practice</h3>
                  <p className="text-xs text-slate-500 font-sans mt-0.5">Have fluid, hands-free spoken conversations in English & French with ultra-low latency</p>
                </div>

                {/* Connection Badge */}
                <div className="flex items-center gap-2">
                  <div className={`w-3 h-3 rounded-full ${
                    liveTabStatus === "live" ? "bg-emerald-500 animate-pulse shadow-[0_0_8px_#10b981]" :
                    liveTabStatus === "connecting" ? "bg-amber-500 animate-pulse" :
                    liveTabStatus === "error" ? "bg-rose-500" : "bg-slate-400"
                  }`} />
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-600">
                    {liveTabStatus === "live" && "Connected (Live)"}
                    {liveTabStatus === "connecting" && "Dialing Proxy..."}
                    {liveTabStatus === "error" && "Error"}
                    {liveTabStatus === "disconnected" && "Offline"}
                  </span>
                </div>
              </div>

              {/* Bento Grid layout */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 p-8">
                
                {/* Panel 1: Tutor Studio Settings & Session controls */}
                <div className="lg:col-span-4 space-y-6 flex flex-col justify-between">
                  {/* Tutor Styling preferences */}
                  <div className="space-y-4">
                    <h4 className="text-xs font-bold text-[#5A5A40] uppercase tracking-widest">
                      🎙️ Voice Studio Selection
                    </h4>

                    {/* Pre-built voice option selector */}
                    <div className="grid grid-cols-2 gap-2">
                      {[
                        { id: "Aoede", label: "Aoede (Calm 👩)" },
                        { id: "Kore", label: "Kore (Soft 👩)" },
                        { id: "Puck", label: "Puck (Chubby 👨)" },
                        { id: "Charon", label: "Charon (Deep 👨)" },
                        { id: "Fenrir", label: "Fenrir (Warm 👨)" }
                      ].map((voiceOpt) => (
                        <button
                          key={voiceOpt.id}
                          disabled={liveTabStatus === "live" || liveTabStatus === "connecting"}
                          onClick={() => setLiveVoice(voiceOpt.id)}
                          className={`py-2 px-3 text-xs font-semibold rounded-xl border text-left transition-all ${
                            liveVoice === voiceOpt.id
                              ? "border-[#5A5A40] bg-[#5A5A40]/10 text-slate-800 shadow-sm"
                              : "border-slate-200 bg-white/40 text-slate-500 hover:bg-white"
                          } ${(liveTabStatus === "live" || liveTabStatus === "connecting") && "opacity-60 cursor-not-allowed"}`}
                        >
                          {voiceOpt.label}
                        </button>
                      ))}
                    </div>

                    {/* System Prompt Instructions Customization */}
                    <div className="space-y-2">
                      <label className="text-xs text-slate-500 font-bold uppercase tracking-wide">
                        🧠 Interactive Roleplaying instructions:
                      </label>
                      <textarea
                        disabled={liveTabStatus === "live" || liveTabStatus === "connecting"}
                        value={liveInstructions}
                        onChange={(e) => setLiveInstructions(e.target.value)}
                        rows={4}
                        className="w-full text-xs p-3 rounded-2xl bg-white border border-slate-200 outline-none focus:border-[#5A5A40] text-slate-700 leading-relaxed resize-none disabled:opacity-60 disabled:cursor-not-allowed"
                        placeholder="Define system properties for the tutor persona..."
                      />
                    </div>
                  </div>

                  {/* Call to Actions & Mic indicator */}
                  <div className="space-y-4 pt-4 border-t border-slate-200/40">
                    
                    {/* Visualizer and Pulsator state during call */}
                    {liveTabStatus === "live" && (
                      <div className="flex flex-col items-center justify-center py-4 bg-slate-50/50 rounded-2xl border border-slate-200/50 space-y-3">
                        {/* Audio Wave representation */}
                        <div className="flex items-center gap-1.5 h-8">
                          {[1, 2, 3, 4, 5, 6, 7, 8].map((wave) => (
                            <div 
                              key={wave}
                              className={`w-1 rounded-full bg-olive-deep ${
                                isLiveMicActive 
                                  ? "animate-pulse" 
                                  : "bg-slate-300"
                              }`}
                              style={{
                                height: `${Math.floor(Math.random() * 20) + 8}px`,
                                animationDelay: `${wave * 150}ms`,
                                animationDuration: "800ms"
                              }}
                            />
                          ))}
                        </div>

                        <span className="text-xs font-semibold text-slate-500">
                          {isLiveMicActive ? "Mic Unmuted: Speak when ready" : "Microphone Muted (Hold to speak)"}
                        </span>

                        {/* Direct mic mute toggle */}
                        <button
                          onClick={() => setIsLiveMicActive(!isLiveMicActive)}
                          className={`flex items-center gap-2 py-1.5 px-4 rounded-full text-xs font-bold transition-all ${
                            isLiveMicActive
                              ? "bg-amber-100 text-amber-800 hover:bg-amber-200 border border-amber-200"
                              : "bg-emerald-100 text-emerald-800 hover:bg-emerald-200 border border-emerald-200"
                          }`}
                        >
                          {isLiveMicActive ? (
                            <>
                              <MicOff className="w-3.5 h-3.5" /> Mute Microphone
                            </>
                          ) : (
                            <>
                              <Mic className="w-3.5 h-3.5" /> Unmute Microphone
                            </>
                          )}
                        </button>
                      </div>
                    )}

                    {/* Connect Button */}
                    <button
                      onClick={toggleLiveVoiceSession}
                      className={`w-full py-3.5 rounded-2xl cursor-pointer text-sm font-bold flex items-center justify-center gap-2 transition-all shadow-md active:scale-95 ${
                        liveTabStatus === "live"
                          ? "bg-rose-500 text-white hover:bg-rose-600 shadow-rose-200"
                          : liveTabStatus === "connecting"
                          ? "bg-amber-500 text-white animate-pulse shadow-amber-200"
                          : "olive-bg text-white hover:opacity-90 shadow-slate-200"
                      }`}
                    >
                      {liveTabStatus === "live" ? (
                        <>
                          <VolumeX className="w-4 h-4" /> End Conversating Session
                        </>
                      ) : liveTabStatus === "connecting" ? (
                        <>
                          <RefreshCw className="w-4 h-4 animate-spin" /> Connection in Progress...
                        </>
                      ) : (
                        <>
                          <Volume2 className="w-4 h-4" /> Connect Live voice tutor
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {/* Panel 2: Live Scrolling Transcript Board */}
                <div className="lg:col-span-8 flex flex-col h-[500px] border border-slate-200/50 bg-slate-50/20 rounded-3xl overflow-hidden shadow-inner">
                  
                  {/* Active Transcript Header */}
                  <div className="px-5 py-3.5 bg-white/50 border-b border-slate-200/40 flex items-center justify-between">
                    <span className="text-xs font-bold text-[#5A5A40] uppercase tracking-wide">
                      💬 Real-Time Streaming Transcript
                    </span>
                    <button
                      onClick={() => setLiveMessages([])}
                      className="text-[10px] font-bold text-slate-400 hover:text-slate-600 uppercase"
                    >
                      Clear Logs
                    </button>
                  </div>

                  {/* Messages Bubble wrapper */}
                  <div className="flex-1 overflow-y-auto p-6 space-y-4">
                    {liveMessages.length === 0 ? (
                      <div className="h-full flex flex-col items-center justify-center text-center p-8 space-y-3">
                        <div className="bg-[#5A5A40]/10 text-olive-deep p-4 rounded-full">
                          <Volume2 className="w-8 h-8" />
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-slate-700">Real-Time Bilingual Studio</p>
                          <p className="text-xs text-slate-400 max-w-xs mx-auto mt-1">
                            Click 'Connect Live voice tutor' to start a bidirectional audio link. Tap Unmute and speak directly into your device's mic to practice fluently.
                          </p>
                        </div>
                      </div>
                    ) : (
                      liveMessages.map((msg, idx) => {
                        const isSystem = msg.text.startsWith("[System]:");
                        const cleanText = isSystem ? msg.text.replace("[System]:", "").trim() : msg.text;

                        if (isSystem) {
                          return (
                            <div key={idx} className="flex justify-center my-2 p-1">
                              <span className="bg-slate-100 border border-slate-200/50 rounded-full px-4 py-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500 shadow-sm">
                                ℹ️ {cleanText}
                              </span>
                            </div>
                          );
                        }

                        const isUser = msg.sender === "user";
                        return (
                          <div
                            key={idx}
                            className={`flex ${isUser ? "justify-end" : "justify-start"} items-end gap-2`}
                          >
                            {/* Profile Tag (Left Model) */}
                            {!isUser && (
                              <div className="w-7 h-7 bg-[#5A5A40] text-white flex items-center justify-center rounded-full text-[10px] font-black uppercase text-center shrink-0">
                                🇫🇷
                              </div>
                            )}

                            <div
                              className={`max-w-[80%] rounded-2xl px-4 py-3 text-xs leading-relaxed shadow-sm font-medium ${
                                isUser
                                  ? "bg-slate-800 text-white rounded-br-none"
                                  : "bg-white border border-slate-200 text-slate-800 rounded-bl-none"
                              }`}
                            >
                              <p>{cleanText}</p>
                              <span className={`block text-[8px] mt-1 text-right ${
                                isUser ? "text-slate-300" : "text-slate-400"
                              }`}>
                                {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                              </span>
                            </div>

                            {/* Profile Tag (Right User) */}
                            {isUser && (
                              <div className="w-7 h-7 bg-slate-300 text-slate-700 flex items-center justify-center rounded-full text-[10px] font-bold uppercase shrink-0">
                                🇺🇸
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                    <div ref={liveChatEndRef} />
                  </div>
                </div>

              </div>
            </div>
          </div>
        )}

      </main>

      {/* Humble Human Labeling in footer */}
      <footer className="border-t border-slate-300/20 bg-transparent py-8 mt-16 text-center text-xs text-slate-400 font-sans">
        <p className="font-serif italic text-sm text-slate-500">FrancoSpeak • Interactive English-French Speaking Translator</p>
        <p className="mt-1 text-[10px] uppercase tracking-wider text-slate-400">Powered by Gemini AI, SpeechSynthesis & SpeechRecognition Local Audio processors</p>
      </footer>
    </div>
  );
}
