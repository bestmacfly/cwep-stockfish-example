# CEWP Stockfish Example

Reference implementation of a CEWP-compatible web plugin using Stockfish
(WASM).

------------------------------------------------------------------------

## 🎯 Purpose

This project demonstrates how to integrate a chess engine into a
CEWP-compatible web plugin.

It uses Stockfish compiled to WebAssembly as an example engine, but CEWP
itself is engine-agnostic.

------------------------------------------------------------------------

## 🧩 Overview

This plugin can be used by any CEWP-compatible host (e.g. a native app
embedding a WebView).

Host App ↓ CEWP Plugin (this project) ↓ Stockfish (WASM)

------------------------------------------------------------------------

## 📦 Project Structure

public/ 
  index.html 
  app.js 
  config.js 
  stockfish/

------------------------------------------------------------------------

## 🚀 Setup

1.  Place a browser-compatible Stockfish build into:

public/stockfish/

2.  Ensure the engine script path is configured in:

public/config.js

3.  Serve the `public/` directory:

``` bash
cd public
python3 -m http.server 8080
```

4.  Open in browser:

http://localhost:8080

------------------------------------------------------------------------

## 🔌 CEWP Integration

### Host → Plugin

``` javascript
window.cwepReceiveMessage(message)
```

### Plugin → Host

``` javascript
window.webkit.messageHandlers.cwep.postMessage(message)
```

------------------------------------------------------------------------

## 📡 Supported Messages

-   hello
-   getCapabilities
-   setPosition
-   startAnalysis
-   stopAnalysis

------------------------------------------------------------------------

## ♟️ Notes

-   Positions are provided via FEN
-   Moves are returned in UCI format
-   The plugin sends progressive analysis updates

------------------------------------------------------------------------

## 🔗 Related

-   CEWP Specification (core)
-   CEWP Advanced Specification
