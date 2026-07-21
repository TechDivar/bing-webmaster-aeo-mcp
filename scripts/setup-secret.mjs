#!/usr/bin/env node

import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { defaultCredentialPath } from "../src/config/credentials.mjs";

const secretType = process.argv[2];
const definitions = {
  bing: {
    fileName: "bing-webmaster-api-key",
    heading: "Bing Webmaster MCP secure setup",
    prompt: "Paste your Bing Webmaster API key, then press Enter: ",
    validate: value => value.length >= 8,
    invalid: "That key looks too short. Nothing was saved."
  },
  indexnow: {
    fileName: "indexnow-key",
    heading: "IndexNow secure setup",
    prompt: "Enter your 8 to 128 character IndexNow key, then press Enter: ",
    validate: value => /^[A-Za-z0-9-]{8,128}$/.test(value),
    invalid: "That key does not match the official IndexNow format. Nothing was saved."
  }
};

function readHidden(prompt) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error("Run this setup in an interactive terminal so the key can be hidden.");
  }

  process.stdout.write(prompt);
  process.stdin.setEncoding("utf8");
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise((resolve, reject) => {
    let value = "";

    const finish = result => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      resolve(result);
    };

    const onData = chunk => {
      for (const character of chunk) {
        if (character === "\u0003") {
          process.stdout.write("\n");
          process.stdin.setRawMode(false);
          process.stdin.pause();
          reject(new Error("Setup cancelled. Nothing was saved."));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish(value.trim());
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };

    process.stdin.on("data", onData);
  });
}

async function saveSecret(fileName, value) {
  const destination = defaultCredentialPath(fileName);
  const secretDirectory = dirname(destination);
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;

  await mkdir(secretDirectory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, `${value}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return destination;
}

async function main() {
  const definition = definitions[secretType];
  if (!definition) {
    throw new Error("Choose bing or indexnow.");
  }

  process.stdout.write(`\n${definition.heading}\n`);
  const value = await readHidden(definition.prompt);
  if (!definition.validate(value)) {
    throw new Error(definition.invalid);
  }

  const destination = await saveSecret(definition.fileName, value);
  process.stdout.write(`Key saved securely at ${destination}.\n`);
  process.stdout.write("Restart your MCP client before using the related tools.\n");
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
