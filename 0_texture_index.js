const fs = require('fs').promises;
const path = require('path');
const { Jimp } = require('jimp');

const TEXTURE_SIZE = 8;
const TEXTURES_DIR = path.join(__dirname, 'textures');
const OUTPUT_JSON_FILE = path.join(__dirname, '1_texture_index.json');
const MAP_FILE = path.join(__dirname, 'block_texture_map.json');
const OUTPUT_BLOCKID_LIST_FILE = path.join(__dirname, '2_texture_index_available_block_ids.json');
const atlasCache = {};
function getSimpleFaceName(complexFaceName) {
    if (complexFaceName.includes('Top')) return 'top';
    if (complexFaceName.includes('Bottom')) return 'bottom';
    if (complexFaceName.includes('Front')) return 'front';
    if (complexFaceName.includes('Back')) return 'back';
    if (complexFaceName.includes('Right')) return 'right';
    if (complexFaceName.includes('Left')) return 'left';
    console.warn(`Could not determine simple face name for: ${complexFaceName}`);
    return 'unknown';
}

async function getAtlas(atlasFileIndex) {
    if (atlasCache[atlasFileIndex]) return atlasCache[atlasFileIndex];
    const atlasPath = path.join(TEXTURES_DIR, `atlas_${atlasFileIndex}.png`);
    try {
        const atlas = await Jimp.read(atlasPath);
        atlasCache[atlasFileIndex] = atlas;
        return atlas;
    } catch (err) {
        console.error(`Failed to load atlas image: ${atlasPath}`, err);
        throw err;
    }
}

async function analyzeTexture(textureInfo) {
    const { atlasFileIndex, textureIndexOnAtlas } = textureInfo;
    const atlas = await getAtlas(atlasFileIndex);
    const texturesPerRow = Math.floor(atlas.width / TEXTURE_SIZE);
    const left = (textureIndexOnAtlas % texturesPerRow) * TEXTURE_SIZE;
    const top = Math.floor(textureIndexOnAtlas / texturesPerRow) * TEXTURE_SIZE;
    const textureImage = atlas.clone().crop({ x: left, y: top, w: TEXTURE_SIZE, h: TEXTURE_SIZE });

    const colorCounts = {};
    let hasTransparency = false;

    textureImage.scan(0, 0, TEXTURE_SIZE, TEXTURE_SIZE, (x, y, idx) => {
        const a = textureImage.bitmap.data[idx + 3];
        let colorKey;
        if (a < 255) {
            hasTransparency = true;
            colorKey = "#transparent";
        } else {
            const r = textureImage.bitmap.data[idx];
            const g = textureImage.bitmap.data[idx + 1];
            const b = textureImage.bitmap.data[idx + 2];
            colorKey = '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
        }
        colorCounts[colorKey] = (colorCounts[colorKey] || 0) + 1;
    });

    const sortedColors = Object.entries(colorCounts).sort(([, countA], [, countB]) => countB - countA);
    const colorHexes = sortedColors.map(([hex]) => hex);
    const colorPixelCounts = sortedColors.map(([, count]) => count);

    return {
        hasTransparency,
        colorCount: colorHexes.length,
        colorHexes: colorHexes,
        colorPixelCounts: colorPixelCounts
    };
}

async function main() {
    try {
        console.log(`Reading data from ${path.basename(MAP_FILE)}...`);
        const mapData = JSON.parse(await fs.readFile(MAP_FILE, 'utf-8'));

        const texturePalette = [];
        const blockMap = {};
        const faceIndex = { top: {}, bottom: {}, front: {}, back: {}, left: {}, right: {} };
        const includedBlockIds = [];
        const textureCache = {};
        const textureIdToBlockIds = {};

        const idsToSkip = new Set([
            '1', '127', '655', '656', '657', '658', '659', '660',
            '1227', '1228', '1229', '1230', '1231', '1232'
        ]);

        const blockEntries = Object.entries(mapData);
        console.log(`Analyzing ${blockEntries.length} blocks...`);

        for (const [blockId, blockData] of blockEntries) {
            if (blockData.name.includes("Slab")) {
                continue;
            }
            if (idsToSkip.has(blockId)) {
                continue;
            }

            includedBlockIds.push(parseInt(blockId, 10));

            blockMap[blockId] = blockData.name;
            const parsedBlockId = parseInt(blockId, 10);

            for (const [complexFaceName, paletteIndex] of Object.entries(blockData.faceMap)) {
                const textureInfo = blockData.texturePalette[paletteIndex];
                if (!textureInfo) continue;

                const cacheKey = `${textureInfo.atlasFileIndex}-${textureInfo.textureIndexOnAtlas}`;
                let textureId;

                if (textureCache[cacheKey] === undefined) {
                    const analysis = await analyzeTexture(textureInfo);
                    textureId = texturePalette.length;
                    textureCache[cacheKey] = textureId;

                    texturePalette.push({
                        textureId,
                        ...textureInfo,
                        ...analysis
                    });
                } else {
                    textureId = textureCache[cacheKey];
                }

                if (!textureIdToBlockIds[textureId]) {
                    textureIdToBlockIds[textureId] = new Set();
                }
                textureIdToBlockIds[textureId].add(parsedBlockId);

                const simpleFaceName = getSimpleFaceName(complexFaceName);
                if (simpleFaceName === 'unknown') continue;

                const analysisResult = texturePalette[textureId];
                for (const colorHex of analysisResult.colorHexes) {
                    if (!faceIndex[simpleFaceName][colorHex]) {
                        faceIndex[simpleFaceName][colorHex] = [];
                    }
                    if (!faceIndex[simpleFaceName][colorHex].includes(textureId)) {
                        faceIndex[simpleFaceName][colorHex].push(textureId);
                    }
                }
            }
        }

        for (const texture of texturePalette) {
            const blockIdSet = textureIdToBlockIds[texture.textureId];
            texture.blockIds = blockIdSet ? Array.from(blockIdSet).sort((a, b) => a - b) : [];
        }

        const finalData = {
            texture_palette: texturePalette,
            block_map: blockMap,
            face_index: faceIndex
        };

        includedBlockIds.sort((a, b) => a - b);
        console.log(`\nWriting available block ID list to ${path.basename(OUTPUT_BLOCKID_LIST_FILE)}...`);
        await fs.writeFile(OUTPUT_BLOCKID_LIST_FILE, JSON.stringify(includedBlockIds));

        console.log(`Analysis complete! Writing final index to ${path.basename(OUTPUT_JSON_FILE)}...`);
        await fs.writeFile(OUTPUT_JSON_FILE, JSON.stringify(finalData));

        console.log("Done!");
        console.log(`Total unique textures found: ${texturePalette.length}`);
        console.log(`Total available block IDs: ${includedBlockIds.length}`);

    } catch (error) {
        console.error('\nAn unrecoverable error occurred:', error);
        process.exit(1);
    }
}

main();