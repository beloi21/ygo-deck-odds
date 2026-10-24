# Oh!-Mi-Yu-Gi by A.R.C. Alberto

A Yu-Gi-Oh! OCG collection tracker and deck builder with optimization and shopping: https://beloi21.github.io/ygo-deck-odds/

This repository only holds the built app that GitHub Pages serves. It is replaced on each release, and a daily job refreshes `banlists.json` (the OCG list from YGOPRODeck), adds images for new cards, and rebuilds the Scan tab's art index (`scan/`). Decks you make in the app are stored in your own browser, not here.

The Scan tab recognises a card from a camera picture on your device; the picture is never uploaded. It matches the artwork with [DINOv2](https://github.com/facebookresearch/dinov2) small (Meta, Apache-2.0; ONNX export by [Xenova](https://huggingface.co/Xenova/dinov2-small)) run by [ONNX Runtime Web](https://onnxruntime.ai/) (MIT), and reads set codes with [Tesseract.js](https://github.com/naptha/tesseract.js) (Apache-2.0).
