const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { Jimp, intToRGBA, ResizeStrategy } = require('jimp');
const gifFrames = require('gif-frames');
const GIFEncoder = require('gif-encoder-2');

const CONFIG = {
    outputWidth: 96,
    outputHeight: null,
    faceDirection: "back",
    FRAMES_PER_SECOND: 20,
    textureSwitchThreshold: 15.0,
    maxVariance: 20,
    searchDepth: null,
    maxColorCount: null,
    allowTransparency: false,
    TEXTURE_SIZE: 8,
    TEXTURES_DIR: path.join(__dirname, 'textures'),
    INDEX_FILE: path.join(__dirname, '1_texture_index.json'),
};
const atlasCache = {};
const textureImageCache = {};

function streamToBuffer(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
}

function colorDistance(rgb1, rgb2) {
    const rDiff = rgb1.r - rgb2.r;
    const gDiff = rgb1.g - rgb2.g;
    const bDiff = rgb1.b - rgb2.b;
    return Math.sqrt(rDiff * rDiff + gDiff * gDiff + bDiff * bDiff);
}

function hexToRgb(hex) {
    if (hex === '#transparent') return null;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return { r, g, b };
}

function calculatePerceivedColor(texture, depth) {
    let totalR = 0, totalG = 0, totalB = 0, totalPixels = 0;
    const limit = Math.min(depth, texture.colorHexes.length);
    for (let i = 0; i < limit; i++) {
        const hex = texture.colorHexes[i], count = texture.colorPixelCounts[i], rgb = hexToRgb(hex);
        if (rgb) { totalR += rgb.r * count; totalG += rgb.g * count; totalB += rgb.b * count; totalPixels += count; }
    }
    if (totalPixels === 0) return null;
    return { r: Math.round(totalR / totalPixels), g: Math.round(totalG / totalPixels), b: Math.round(totalB / totalPixels) };
}

function calculateColorVariance(texture) {
    if (texture.colorCount <= 1) return 0;
    const meanColor = calculatePerceivedColor(texture, Infinity);
    if (!meanColor) return 0;
    let totalWeightedDistance = 0, totalPixels = 0;
    for (let i = 0; i < texture.colorHexes.length; i++) {
        const hex = texture.colorHexes[i], count = texture.colorPixelCounts[i], rgb = hexToRgb(hex);
        if (rgb) { const distance = colorDistance(rgb, meanColor); totalWeightedDistance += distance * count; totalPixels += count; }
    }
    if (totalPixels === 0) return 0;
    return totalWeightedDistance / totalPixels;
}

async function loadAndPrepareCandidates(textureData) {
    console.log("Preparing candidate textures based on your config...");
    const faceIndex = textureData.face_index[CONFIG.faceDirection];
    if (!faceIndex) throw new Error(`Face direction "${CONFIG.faceDirection}" not found.`);
    const validTextureIdsForFace = new Set(Object.values(faceIndex).flat());
    const candidates = [];
    for (const texture of textureData.texture_palette) {
        if (!validTextureIdsForFace.has(texture.textureId)) continue;
        if (CONFIG.maxColorCount !== null && texture.colorCount > CONFIG.maxColorCount) continue;
        if (!CONFIG.allowTransparency && texture.hasTransparency) continue;
        if (CONFIG.maxVariance !== null) { if (calculateColorVariance(texture) > CONFIG.maxVariance) continue; }
        const perceivedColor = calculatePerceivedColor(texture, CONFIG.searchDepth ?? Infinity);
        if (perceivedColor) { candidates.push({ textureInfo: texture, perceivedColor }); }
    }
    if (candidates.length === 0) throw new Error('No candidate textures found with the specified filters.');
    console.log(`Prepared ${candidates.length} valid candidate textures.`);
    return candidates;
}

function findBestMatch(pixelColor, candidates, previousTextureId) {
    let bestOverallMatch = null, minDistance = Infinity;
    for (const candidate of candidates) {
        const distance = colorDistance(pixelColor, candidate.perceivedColor);
        if (distance < minDistance) { minDistance = distance; bestOverallMatch = candidate; }
    }
    if (!bestOverallMatch) return null;
    if (previousTextureId === null) return bestOverallMatch.textureInfo;
    if (bestOverallMatch.textureInfo.textureId === previousTextureId) return bestOverallMatch.textureInfo;
    const previousCandidate = candidates.find(c => c.textureInfo.textureId === previousTextureId);
    if (!previousCandidate) return bestOverallMatch.textureInfo;
    const previousMatchDistance = colorDistance(pixelColor, previousCandidate.perceivedColor);
    const improvement = previousMatchDistance - minDistance;
    return improvement > CONFIG.textureSwitchThreshold ? bestOverallMatch.textureInfo : previousCandidate.textureInfo;
}

async function getAtlas(atlasFileIndex) {
    if (atlasCache[atlasFileIndex]) return atlasCache[atlasFileIndex];
    const atlasPath = path.join(CONFIG.TEXTURES_DIR, `atlas_${atlasFileIndex}.png`);
    const atlas = await Jimp.read(atlasPath);
    atlasCache[atlasFileIndex] = atlas;
    return atlas;
}

async function getTextureImage(textureInfo) {
    const { atlasFileIndex, textureIndexOnAtlas } = textureInfo;
    const cacheKey = `${atlasFileIndex}-${textureIndexOnAtlas}`;
    if (textureImageCache[cacheKey]) return textureImageCache[cacheKey];
    const atlas = await getAtlas(atlasFileIndex);
    const texturesPerRow = Math.floor(atlas.width / CONFIG.TEXTURE_SIZE);
    const left = (textureIndexOnAtlas % texturesPerRow) * CONFIG.TEXTURE_SIZE;
    const top = Math.floor(textureIndexOnAtlas / texturesPerRow) * CONFIG.TEXTURE_SIZE;
    const textureImage = atlas.clone().crop({ x: left, y: top, w: CONFIG.TEXTURE_SIZE, h: CONFIG.TEXTURE_SIZE });
    textureImageCache[cacheKey] = textureImage;
    return textureImage;
}

async function generateBlueprintFiles(choicesGrid, texturePalette, basePath) {
    console.log("Generating blueprint files...");
    const height = choicesGrid.length;
    if (height === 0) return;
    const width = choicesGrid[0].length;

    const UNICODE_PRIVATE_USE_START = 0xE000;
    const stringBuilder = [];

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const textureId = choicesGrid[y][x];
            let blockId = 0;

            if (textureId !== null) {
                const texture = texturePalette[textureId];
                if (texture && texture.blockIds && texture.blockIds.length > 0) {
                    blockId = texture.blockIds[0];
                }
            }

            const charCode = UNICODE_PRIVATE_USE_START + blockId;
            stringBuilder.push(String.fromCodePoint(charCode));
        }
    }

    const blockMapString = stringBuilder.join('');
    const config = { width, height };

    const stringPath = basePath + '.txt';
    const configPath = basePath + '.json';

    await fsp.writeFile(stringPath, blockMapString, 'utf-8');
    await fsp.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
    console.log(`Blueprint saved to ${stringPath} and ${configPath}`);
}


async function processImageFrame(sourceFrame, candidates, previousFrameChoices) {
    let { outputWidth, outputHeight } = CONFIG;
    if (outputWidth && !outputHeight) { outputHeight = Math.round(sourceFrame.height * (outputWidth / sourceFrame.width)); }
    else if (outputHeight && !outputWidth) { outputWidth = Math.round(sourceFrame.width * (outputHeight / sourceFrame.height)); }

    const blueprint = sourceFrame.clone().resize({ w: outputWidth, h: outputHeight, mode: ResizeStrategy.NEAREST_NEIGHBOR });
    const finalImage = new Jimp({ width: outputWidth * CONFIG.TEXTURE_SIZE, height: outputHeight * CONFIG.TEXTURE_SIZE });
    const currentFrameChoices = Array(blueprint.height).fill(null).map(() => Array(blueprint.width).fill(null));

    for (let y = 0; y < blueprint.height; y++) {
        for (let x = 0; x < blueprint.width; x++) {
            const pixelColorInt = blueprint.getPixelColor(x, y);
            const previousChoiceId = previousFrameChoices ? previousFrameChoices[y][x] : null;
            const pixelRGBA = intToRGBA(pixelColorInt);
            const bestTextureInfo = findBestMatch(pixelRGBA, candidates, previousChoiceId);
            if (bestTextureInfo) {
                const textureToDraw = await getTextureImage(bestTextureInfo);
                finalImage.composite(textureToDraw, x * CONFIG.TEXTURE_SIZE, y * CONFIG.TEXTURE_SIZE);
                currentFrameChoices[y][x] = bestTextureInfo.textureId;
            }
        }
    }
    return { finalImage, currentFrameChoices };
}

async function main() {
    const inputFile = process.argv[2];
    if (!inputFile) { console.error('Usage: node bloxelizer.js <path/to/your/image.gif>'); process.exit(1); }

    try {
        console.log(`Loading texture index from ${path.basename(CONFIG.INDEX_FILE)}...`);
        const textureData = await fsp.readFile(CONFIG.INDEX_FILE, 'utf-8').then(JSON.parse);
        const candidates = await loadAndPrepareCandidates(textureData);

        const isGif = path.extname(inputFile).toLowerCase() === '.gif';
        const baseName = path.basename(inputFile, path.extname(inputFile));
        const outputBase = path.join(path.dirname(inputFile), `${baseName}_bloxelized`);

        if (isGif) {
            const outputGifPath = outputBase + '.gif';
            console.log(`Processing GIF, saving final animation to: ${outputGifPath}`);

            const frameData = await gifFrames({ url: inputFile, frames: 'all', outputType: 'png', cumulative: true });
            let previousFrameChoices = null;
            let encoder;

            for (let i = 0; i < frameData.length; i++) {
                const frame = frameData[i];
                console.log(`\n--- Processing Frame ${i + 1}/${frameData.length} ---`);

                const imageStream = frame.getImage();
                const imageBuffer = await streamToBuffer(imageStream);
                const jimpFrame = await Jimp.read(imageBuffer);

                const { finalImage, currentFrameChoices } = await processImageFrame(jimpFrame, candidates, previousFrameChoices);
                previousFrameChoices = currentFrameChoices;

                if (i === 0) {
                    await generateBlueprintFiles(currentFrameChoices, textureData.texture_palette, outputBase);
                    encoder = new GIFEncoder(finalImage.width, finalImage.height);
                    const stream = fs.createWriteStream(outputGifPath);
                    encoder.createReadStream().pipe(stream);
                    encoder.start();
                    encoder.setRepeat(0);
                    encoder.setDelay(1000 / CONFIG.FRAMES_PER_SECOND);
                    encoder.setQuality(1);
                }

                console.log(`Adding frame ${i + 1} to GIF...`);
                encoder.addFrame(finalImage.bitmap.data);
            }

            encoder.finish();
            console.log("\nFinalizing GIF, please wait...");

        } else {
            const outputPath = outputBase + '.png';
            console.log(`Processing static image, saving to: ${outputPath}`);
            const sourceImage = await Jimp.read(inputFile);
            const { finalImage, currentFrameChoices } = await processImageFrame(sourceImage, candidates, null);
            await generateBlueprintFiles(currentFrameChoices, textureData.texture_palette, outputBase);
            await finalImage.write(outputPath);
        }

        console.log(`\n\nSuccess! Processing complete.`);

    } catch (error) {
        console.error('\nAn unrecoverable error occurred:', error.stack || error);
        process.exit(1);
    }
}

main();