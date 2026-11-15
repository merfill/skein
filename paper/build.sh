#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/ru"
latexmk -xelatex -interaction=nonstopmode -halt-on-error skein.tex
latexmk -c skein.tex
rm -f skein.bbl skein.synctex.gz
