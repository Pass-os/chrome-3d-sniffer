# 3D Model Sniffer

Extensão Chrome (Manifest V3) que detecta e baixa modelos 3D das páginas, olhando os bytes das requisições e também as cenas desenhadas em `<canvas>`.

## O que faz

- **Rede:** intercepta `fetch`, `XMLHttpRequest` e `URL.createObjectURL`, lê os primeiros bytes e identifica o formato por magic number (GLB, glTF, FBX, OBJ, STL, PLY, Draco, USD/USDZ, COLLADA, 3DS, Blender, VOX, ZIP com modelo). Também pega por URL/`Content-Type` via `webRequest`.
- **three.js:** registra `window.__THREE_DEVTOOLS__`, recebe cada `Scene` criada e exporta a cena ao vivo para GLB (malhas, instâncias, UV, vertex colors, materiais, texturas).
- **WebGL puro:** hooks em `bufferData`/`vertexAttribPointer`/`draw*` capturam a geometria (só malha, sem textura).
- **Viewer próprio** (botão *Ver*): three.js dentro da extensão; abre GLB (Meshopt), OBJ, STL, PLY, FBX e COLLADA.
- **Blender** (botão *Blender*): baixa e abre no Blender 5.0 via native host; descomprime Meshopt antes.

## Instalação

1. `chrome://extensions` → Modo do desenvolvedor → *Carregar sem compactação* → esta pasta.
2. (Opcional, botão Blender) `cd native && npm install` e `powershell native/install.ps1`. O caminho do Blender está fixo em `native/host.js`.
3. Viewer: o `viewer.js` já vem compilado. Para recompilar: `cd viewer-src && npm install && npm run build`.

O ID da extensão é fixado pelo campo `key` do `manifest.json` (`lnghpdmdpipeikpbjmfoicndhpabhnlc`), que o native host exige em `allowed_origins`.

## Limites conhecidos

- Renderização em Worker/OffscreenCanvas não é vista pelos hooks da janela principal.
- O viewer não abre GLB com compressão Draco (o worker do decodificador exige CSP `blob:`, que o Chrome recusa em extensões); use Baixar ou Blender.
- O fallback WebGL ignora buffers dinâmicos além das primeiras atualizações e não exporta textura nem normais.
- Falta: download pela extensão (hoje usa `<a download>` na página), three.js sem `__THREE_DEVTOOLS__`, texturas KTX2.
