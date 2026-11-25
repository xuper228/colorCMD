# Color ASCII Media Viewer

A Node.js terminal viewer for images, animated GIFs, and videos from the `photos` folder. Images are rendered as colored ASCII art, while videos and GIFs are played frame by frame.

## Run

1. Install Node.js 18 or newer.
2. Put images (`.jpg`, `.jpeg`, `.png`, `.webp`, `.tif`, `.tiff`) or animated GIFs/videos (`.gif`, `.mp4`, `.mov`, `.mkv`, `.avi`, `.webm`, `.m4v`, `.flv`) in the `photos` folder.
3. Run these commands from the project folder:

```bash
npm install
npm start
```

On Windows, you can also double-click `start.bat` to install dependencies if needed and launch the program.

For the best result, maximize the terminal window. The output resolution automatically follows the terminal size.

During video playback, press `q`, `Esc`, or `Ctrl+C` to stop. FFmpeg is installed automatically with the project dependencies.

You can also choose `u` in the menu and paste an `http://` or `https://` GIF URL. The remote GIF is streamed directly and is not saved to disk.
