#!/bin/bash

# This is just for Windows 11 + WSL
# Comment this line if you're using UNIX-based system and got docker-cli installed
# -------------------------------------------------------------------------------
alias docker="wsl docker $*"

# Env...

VERSION=local-dev
POD_NAME=akash-console-air
IMAGE_NAME=${POD_NAME}:${VERSION}

# Build local docker image...
docker build -f deploy/Dockerfile -t ${IMAGE_NAME} .

# Run in local docker...
docker run --rm -p 8080:3001 ${IMAGE_NAME}