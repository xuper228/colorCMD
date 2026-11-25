const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const ffmpegPath = require('ffmpeg-static');
const sharp = require('sharp');

const PHOTOS_DIR = path.join(__dirname, 'photos');
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff']);
const VIDEO_EXTENSIONS = new Set(['.gif', '.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.flv']);

function createPrompt() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function getMedia() {
  await fs.mkdir(PHOTOS_DIR, { recursive: true });
  const files = await fs.readdir(PHOTOS_DIR, { withFileTypes: true });
  return files
    .filter((entry) => {
      const extension = path.extname(entry.name).toLowerCase();
      return entry.isFile() && (IMAGE_EXTENSIONS.has(extension) || VIDEO_EXTENSIONS.has(extension));
    })
    .map((entry) => ({
      name: entry.name,
      type: VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) ? 'video' : 'image',
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

function getTerminalWidth() {
  // The output resolution follows the actual terminal width.
  return Math.max(20, process.stdout.columns || 80);
}

async function renderImage(filePath) {
  return renderFrame(await fs.readFile(filePath));
}

async function renderFrame(frameBuffer, requestedWidth = getTerminalWidth() - 1) {
  const pixelWidth = Math.max(20, requestedWidth);
  const image = sharp(frameBuffer).rotate();
  const metadata = await image.metadata();
  const sourceWidth = metadata.width || pixelWidth;
  const sourceHeight = metadata.height || pixelWidth;
  // A half-block displays two vertical pixels in one character for better detail.
  const maxPixelHeight = Math.max(2, ((process.stdout.rows || 40) - 3) * 2);
  const pixelHeight = Math.max(2, Math.min(
    maxPixelHeight,
    Math.round((sourceHeight / sourceWidth) * pixelWidth),
  ));
  const { data, info } = await image
    .resize(pixelWidth, pixelHeight, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const lines = [];
  for (let y = 0; y < info.height; y += 2) {
    let line = '';
    for (let x = 0; x < info.width; x += 1) {
      const topOffset = (y * info.width + x) * info.channels;
      const bottomOffset = (Math.min(y + 1, info.height - 1) * info.width + x) * info.channels;
      const topRed = data[topOffset];
      const topGreen = data[topOffset + 1];
      const topBlue = data[topOffset + 2];
      const bottomRed = data[bottomOffset];
      const bottomGreen = data[bottomOffset + 1];
      const bottomBlue = data[bottomOffset + 2];
      line += `\x1b[38;2;${topRed};${topGreen};${topBlue}m\x1b[48;2;${bottomRed};${bottomGreen};${bottomBlue}m▀\x1b[0m`;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

function extractJpegs(buffer) {
  const frames = [];
  let start = 0;
  while (start < buffer.length - 1) {
    const soi = buffer.indexOf(Buffer.from([0xff, 0xd8]), start);
    if (soi === -1) break;
    const eoi = buffer.indexOf(Buffer.from([0xff, 0xd9]), soi + 2);
    if (eoi === -1) break;
    frames.push(buffer.subarray(soi, eoi + 2));
    start = eoi + 2;
  }
  return frames;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function playVideo(filePath, fileName, isGif = false) {
  if (!ffmpegPath) throw new Error('Built-in FFmpeg was not found. Run npm install again.');

  // Limit video resolution and FPS for smooth playback, even on slower computers.
  const width = Math.max(20, getTerminalWidth() - 1);
  const frameRate = 10;
  const frameDelay = 1000 / frameRate;
  const filters = isGif
    ? `scale=${width}:-2:flags=fast_bilinear`
    : `fps=${frameRate},scale=${width}:-2:flags=fast_bilinear`;
  const ffmpeg = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    ...(isGif ? ['-stream_loop', '-1'] : []),
    '-i', filePath,
    '-vf', filters,
    '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '6', 'pipe:1',
  ], { windowsHide: true });

  let pending = Buffer.alloc(0);
  let stopped = false;
  let ffmpegError = '';
  ffmpeg.stderr.setEncoding('utf8');
  ffmpeg.stderr.on('data', (message) => { ffmpegError += message; });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    ffmpeg.kill();
  };
  const onKey = (key) => {
    const pressedKey = key.toLowerCase();
    if (pressedKey === 'q' || key === '\u0003' || key === '\u001b') stop();
  };

  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onKey);
  process.stdout.write('\x1b[?25l\x1b[2J\x1b[H');
  process.stdout.write(`\x1b[36m${fileName}\x1b[0m  \x1b[90m(q — stop)\x1b[0m\n`);

  try {
    for await (const chunk of ffmpeg.stdout) {
      if (stopped) break;
      pending = Buffer.concat([pending, chunk]);
      const frames = extractJpegs(pending);
      if (frames.length) {
        const lastEnd = pending.lastIndexOf(Buffer.from([0xff, 0xd9])) + 2;
        pending = pending.subarray(lastEnd);
      }
      if (isGif) {
        // Do not skip GIF frames: every frame must be displayed.
        for (const frame of frames) {
          if (stopped) break;
          const rendered = await renderFrame(frame, width);
          process.stdout.write(`\x1b[2;1H${rendered}\x1b[0J`);
          await wait(frameDelay);
        }
      } else {
        // For long videos, show the newest frame to prevent playback lag.
        const frame = frames.at(-1);
        if (frame && !stopped) {
          const rendered = await renderFrame(frame, width);
          process.stdout.write(`\x1b[2;1H${rendered}\x1b[0J`);
          await wait(frameDelay);
        }
      }
    }
    await new Promise((resolve) => ffmpeg.once('close', resolve));
    if (ffmpeg.exitCode !== 0 && !stopped) {
      throw new Error(ffmpegError || 'FFmpeg could not read this video.');
    }
  } finally {
    stop();
    process.stdin.off('data', onKey);
    process.stdin.setRawMode?.(false);
    process.stdout.write('\x1b[?25h\x1b[0m\n');
  }
}

async function main() {
  const rl = createPrompt();
  console.clear();
  console.log('\x1b[36m=== Color ASCII Media Viewer ===\x1b[0m\n');

  try {
    const media = await getMedia();
    if (media.length === 0) {
      console.log(`There are no media files in ${path.relative(process.cwd(), PHOTOS_DIR) || 'photos'}.`);
      console.log('You can still open an animated GIF from a URL below.\n');
    }

    console.log('Choose a file:\n');
    media.forEach((item, index) => console.log(`  ${index + 1}. ${item.name} ${item.type === 'video' ? '🎬' : '🖼️'}`));
    console.log('  u. Open a GIF from a URL');
    console.log('  q. Quit\n');

    const answer = (await ask(rl, 'Your choice: ')).trim().toLowerCase();
    if (answer === 'q') return;

    if (answer === 'u') {
      const remoteUrl = (await ask(rl, 'Paste the GIF URL: ')).trim();
      let parsedUrl;
      try {
        parsedUrl = new URL(remoteUrl);
      } catch {
        console.log('\n\x1b[31mInvalid URL.\x1b[0m');
        return;
      }
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        console.log('\n\x1b[31mThe URL must start with http:// or https://.\x1b[0m');
        return;
      }

      rl.close();
      console.clear();
      await playVideo(remoteUrl, 'GIF from URL', true);
      return;
    }

    const selectedIndex = Number(answer) - 1;
    if (!Number.isInteger(selectedIndex) || !media[selectedIndex]) {
      console.log('\n\x1b[31mInvalid file number.\x1b[0m');
      return;
    }

    const selectedMedia = media[selectedIndex];
    console.clear();
    const selectedPath = path.join(PHOTOS_DIR, selectedMedia.name);
    if (selectedMedia.type === 'video') {
      // Stop readline from consuming q before the video key handler sees it.
      rl.close();
      await playVideo(selectedPath, selectedMedia.name, path.extname(selectedMedia.name).toLowerCase() === '.gif');
    } else {
      console.log(`\x1b[36m${selectedMedia.name}\x1b[0m\n`);
      console.log(await renderImage(selectedPath));
      console.log('\n\n\x1b[90mDone.\x1b[0m');
    }
  } catch (error) {
    console.error(`\n\x1b[31mCould not process the media: ${error.message}\x1b[0m`);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

main();
