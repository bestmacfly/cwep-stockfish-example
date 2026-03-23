(function () {
  const DEFAULT_CONFIG = {
    pluginId: "cewp-stockfish-example",
    pluginName: "CEWP Stockfish Example",
    pluginVersion: "1.0.0",
    stockfishScriptUrl: "./stockfish/stockfish.js",
    scorePov: "sideToMove",
    defaultMultiPv: 1
  };

  const CONFIG = Object.assign({}, DEFAULT_CONFIG, window.CEWP_STOCKFISH_CONFIG || {});

  const state = {
    status: "idle",
    currentFen: null,
    currentRequestId: null,
    engineLoaded: false,
    engineReady: false,
    bestMove: null,
    lastDepth: null,
    lastScore: null,
    lastPv: [],
    currentMultiPv: CONFIG.defaultMultiPv,
    worker: null
  };

  const ui = {
    pluginName: document.getElementById("pluginName"),
    state: document.getElementById("state"),
    engineStatus: document.getElementById("engineStatus"),
    fen: document.getElementById("fen"),
    depth: document.getElementById("depth"),
    score: document.getElementById("score"),
    bestMove: document.getElementById("bestMove"),
    pv: document.getElementById("pv"),
    log: document.getElementById("log")
  };

  function setState(next) {
    state.status = next;
    ui.state.textContent = next;
  }

  function log(message, payload) {
    const line = payload ? `${message} ${JSON.stringify(payload)}` : message;
    ui.log.textContent = `${new Date().toISOString()}  ${line}\n` + ui.log.textContent;
    console.log("[CEWP]", message, payload || "");
  }

  function postToHost(message) {
    log("plugin → host", message);

    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.cwep) {
      window.webkit.messageHandlers.cwep.postMessage(message);
      return;
    }

    const event = new CustomEvent("cewp-message", { detail: message });
    window.dispatchEvent(event);
  }

  function wrapMessage(type, requestId, payload) {
    return {
      protocol: "cewp",
      version: "1.0",
      type,
      requestId: requestId || undefined,
      payload: payload || {}
    };
  }

  function updateUi() {
    ui.pluginName.textContent = `${CONFIG.pluginName} ${CONFIG.pluginVersion}`;
    ui.engineStatus.textContent = state.engineLoaded
      ? (state.engineReady ? "ready" : "loading")
      : "not loaded";
    ui.fen.textContent = state.currentFen || "—";
    ui.depth.textContent = state.lastDepth ?? "—";
    ui.score.textContent = state.lastScore || "—";
    ui.bestMove.textContent = state.bestMove || "—";
    ui.pv.textContent = state.lastPv.length ? state.lastPv.join(" ") : "—";
  }

  function sendError(requestId, code, message, recoverable = false) {
    postToHost(wrapMessage("error", requestId, {
      code,
      message,
      recoverable
    }));
  }

  function sendHelloAck(requestId) {
    postToHost(wrapMessage("helloAck", requestId, {
      plugin: {
        id: CONFIG.pluginId,
        name: CONFIG.pluginName,
        version: CONFIG.pluginVersion
      }
    }));
  }

  function sendCapabilities(requestId) {
    postToHost(wrapMessage("capabilities", requestId, {
      features: {
        analysis: true,
        multiPv: true,
        setOptions: true
      },
      options: [
        { key: "threads", type: "integer", min: 1, max: 32, default: 1 },
        { key: "hashMb", type: "integer", min: 1, max: 2048, default: 16 }
      ]
    }));
  }

  function sendAnalysisComplete(requestId, stoppedBy) {
    postToHost(wrapMessage("analysisComplete", requestId, {
      final: {
        score: state.lastScoreObject || null,
        bestMove: state.bestMove || null,
        pv: state.lastPv || []
      },
      stoppedBy: stoppedBy || "limit"
    }));
  }

  function loadEngineIfNeeded() {
    if (state.worker || !window.Worker) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      try {
        state.worker = new Worker(CONFIG.stockfishScriptUrl);
        state.engineLoaded = true;
        setState("ready");
        updateUi();

        state.worker.onmessage = (event) => {
          const text = String(event.data || "");
          handleEngineLine(text);
        };

        state.worker.onerror = (event) => {
          log("engine error", { message: event.message });
          state.engineReady = false;
          updateUi();
        };

        state.worker.postMessage("uci");
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }

  function engineCommand(cmd) {
    if (!state.worker) {
      throw new Error("Engine worker is not available");
    }
    log("host → engine", { cmd });
    state.worker.postMessage(cmd);
  }

  function handleEngineLine(line) {
    log("engine → plugin", { line });

    if (line === "uciok") {
      state.engineReady = true;
      updateUi();
      return;
    }

    if (line.startsWith("bestmove ")) {
      const parts = line.split(/\s+/);
      state.bestMove = parts[1] || null;
      updateUi();

      if (state.currentRequestId) {
        sendAnalysisComplete(state.currentRequestId, "limit");
      }
      setState("ready");
      return;
    }

    if (!line.startsWith("info ")) {
      return;
    }

    const depthMatch = line.match(/\bdepth\s+(\d+)/);
    const scoreCpMatch = line.match(/\bscore\s+cp\s+(-?\d+)/);
    const scoreMateMatch = line.match(/\bscore\s+mate\s+(-?\d+)/);
    const pvMatch = line.match(/\bpv\s+(.+)$/);

    const depth = depthMatch ? Number(depthMatch[1]) : null;
    let score = null;

    if (scoreCpMatch) {
      score = {
        kind: "cp",
        value: Number(scoreCpMatch[1]),
        pov: CONFIG.scorePov
      };
    } else if (scoreMateMatch) {
      score = {
        kind: "mate",
        value: Number(scoreMateMatch[1]),
        pov: CONFIG.scorePov
      };
    }

    const pv = pvMatch ? pvMatch[1].trim().split(/\s+/) : [];

    if (depth !== null) {
      state.lastDepth = depth;
    }
    if (score) {
      state.lastScoreObject = score;
      state.lastScore = score.kind === "cp"
        ? `${score.value} cp`
        : `mate ${score.value}`;
    }
    if (pv.length) {
      state.lastPv = pv;
      state.bestMove = pv[0] || state.bestMove;
    }

    updateUi();

    if (state.currentRequestId) {
      postToHost(wrapMessage("analysisUpdate", state.currentRequestId, {
        depth: state.lastDepth,
        score: state.lastScoreObject || null,
        pv: state.lastPv || [],
        bestMove: state.bestMove || null
      }));
    }
  }

  async function setPosition(payload) {
    if (!payload || !payload.fen) {
      throw new Error("setPosition requires a fen value");
    }

    state.currentFen = payload.fen;
    state.lastDepth = null;
    state.lastScore = null;
    state.lastScoreObject = null;
    state.lastPv = [];
    state.bestMove = null;
    updateUi();
    setState("ready");
  }

  async function startAnalysis(requestId, payload) {
    await loadEngineIfNeeded();

    if (!state.currentFen) {
      sendError(requestId, "INVALID_POSITION", "No position has been set", false);
      return;
    }

    if (!state.engineReady) {
      sendError(requestId, "ENGINE_NOT_READY", "Engine is not ready yet", true);
      return;
    }

    state.currentRequestId = requestId || "analysis";
    state.currentMultiPv = payload && Number.isInteger(payload.multiPv)
      ? payload.multiPv
      : CONFIG.defaultMultiPv;

    const depth = payload && payload.limits && Number.isInteger(payload.limits.depth)
      ? payload.limits.depth
      : null;
    const movetimeMs = payload && payload.limits && Number.isInteger(payload.limits.movetimeMs)
      ? payload.limits.movetimeMs
      : 1000;

    setState("analyzing");
    engineCommand("ucinewgame");
    engineCommand(`setoption name MultiPV value ${state.currentMultiPv}`);
    engineCommand(`position fen ${state.currentFen}`);

    if (depth !== null) {
      engineCommand(`go depth ${depth}`);
    } else {
      engineCommand(`go movetime ${movetimeMs}`);
    }
  }

  function stopAnalysis() {
    if (!state.worker) {
      setState("ready");
      return;
    }

    try {
      engineCommand("stop");
    } catch (error) {
      log("stop failed", { message: error.message });
    }
    setState("ready");
  }

  function setOptions(requestId, payload) {
    if (!payload || typeof payload.options !== "object" || !payload.options) {
      sendError(requestId, "INVALID_PAYLOAD", "setOptions requires an options object", true);
      return;
    }

    loadEngineIfNeeded()
      .then(() => {
        Object.entries(payload.options).forEach(([key, value]) => {
          const optionName = key === "hashMb" ? "Hash" : key === "threads" ? "Threads" : key;
          engineCommand(`setoption name ${optionName} value ${value}`);
        });
      })
      .catch((error) => {
        sendError(requestId, "ENGINE_NOT_READY", error.message, true);
      });
  }

  window.cwepReceiveMessage = async function (message) {
  log("host → plugin raw", {
    typeOf: typeof message,
    protocol: message && message.protocol ? message.protocol : null,
    message
  });

  let normalizedMessage = message;

  // MARK: Manche Hosts übergeben JSON als String statt als Objekt.
  // Für robuste CEWP-Kompatibilität normalisieren wir das hier.
  if (typeof normalizedMessage === "string") {
    try {
      normalizedMessage = JSON.parse(normalizedMessage);
      log("host → plugin parsed string message", normalizedMessage);
    } catch (error) {
      sendError(
        undefined,
        "INVALID_PAYLOAD",
        "Could not parse string message as JSON",
        false
      );
      return;
    }
  }

  try {
    if (!normalizedMessage || normalizedMessage.protocol !== "cewp") {
      throw new Error("Unsupported or missing protocol");
    }

    switch (normalizedMessage.type) {
      case "hello":
        sendHelloAck(normalizedMessage.requestId);
        break;

      case "getCapabilities":
        sendCapabilities(normalizedMessage.requestId);
        break;

      case "setPosition":
        await setPosition(normalizedMessage.payload);
        break;

      case "startAnalysis":
        await startAnalysis(
          normalizedMessage.requestId,
          normalizedMessage.payload
        );
        break;

      case "stopAnalysis":
        stopAnalysis();
        break;

      case "setOptions":
        setOptions(
          normalizedMessage.requestId,
          normalizedMessage.payload
        );
        break;

      default:
        sendError(
          normalizedMessage.requestId,
          "UNSUPPORTED_MESSAGE",
          `Unsupported message type: ${normalizedMessage.type}`,
          true
        );
    }
  } catch (error) {
    sendError(
      normalizedMessage && normalizedMessage.requestId,
      "INTERNAL_ERROR",
      error.message || String(error),
      false
    );
  }
};
  updateUi();
  loadEngineIfNeeded().catch((error) => {
    log("engine load failed", { message: error.message });
    sendError(undefined, "ENGINE_NOT_READY", "Stockfish assets could not be loaded. Add a browser build under public/stockfish/ and adjust config.js.", true);
    updateUi();
  });
})();
