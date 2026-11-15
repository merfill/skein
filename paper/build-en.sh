#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/en"
latexmk -xelatex -interaction=nonstopmode -halt-on-error skein.tex
latexmk -c skein.tex
rm -f skein.bbl skein.synctex.gz
