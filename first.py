import json
from PIL import Image
import os
import math

BLOCK_TEXTURE_MAP_PATH = 'block_texture_map.json'
ATLAS_PREFIX = 'texture_atlas_'
ATLAS_EXTENSION = '.png'
CACHE_OUTPUT_PATH = 'block_color_cache.json'
BLOCK_WIDTH = 8
MONO_COLOR_STD_DEV_THRESHOLD = 12.0

SIDE_FACE_KEYS = [
    "face_0_Right_PlusX", "face_1_Left_MinusX",
    "face_4_Front_PlusZ", "face_5_Back_MinusZ"
]

def analyze_texture(image: Image.Image) -> tuple[tuple[int, int, int], bool, bool]:
    img_rgba = image.convert('RGBA')
    pixels = list(img_rgba.getdata())
    
    has_transparency = any(a < 255 for r, g, b, a in pixels)
    opaque_pixels = [(r, g, b) for r, g, b, a in pixels if a == 255]
    
    if not opaque_pixels:
        return ((0, 0, 0), has_transparency, True)

    avg_r = sum(p[0] for p in opaque_pixels) / len(opaque_pixels)
    avg_g = sum(p[1] for p in opaque_pixels) / len(opaque_pixels)
    avg_b = sum(p[2] for p in opaque_pixels) / len(opaque_pixels)
    avg_color = (int(avg_r), int(avg_g), int(avg_b))

    sum_sq_diff = sum((p[0] - avg_r)**2 + (p[1] - avg_g)**2 + (p[2] - avg_b)**2 for p in opaque_pixels)
    std_dev = math.sqrt(sum_sq_diff / len(opaque_pixels))
    is_monocolor = std_dev < MONO_COLOR_STD_DEV_THRESHOLD
        
    return (avg_color, has_transparency, is_monocolor)

def main():
    print("Generating a detailed 'face palette' color cache...")

    try:
        with open(BLOCK_TEXTURE_MAP_PATH, 'r') as f:
            block_texture_map = json.load(f)
        
        atlas_images = []
        i = 0
        while os.path.exists(f"{ATLAS_PREFIX}{i}{ATLAS_EXTENSION}"):
            atlas_images.append(Image.open(f"{ATLAS_PREFIX}{i}{ATLAS_EXTENSION}"))
            i += 1
        if not atlas_images:
            raise FileNotFoundError("No texture atlas files found.")
            
        print(f"Loaded {len(atlas_images)} atlas files.")

    except FileNotFoundError as e:
        print(f"Error: Missing required file - {e}")
        return

    face_palette = []
    processed_textures = {}
    slab_count = 0

    for block_id, data in block_texture_map.items():
        block_name = data['name']
        
        if "Slab" in block_name:
            slab_count += 1
            continue

        for face_key in SIDE_FACE_KEYS:
            if face_key in data['faceMap']:
                palette_index = data['faceMap'][face_key]
                texture_location = data['texturePalette'][palette_index]
                texture_unique_key = f"{texture_location['atlasFileIndex']}-{texture_location['textureIndexOnAtlas']}"
                
                if texture_unique_key not in processed_textures:
                    atlas_image = atlas_images[texture_location['atlasFileIndex']]
                    crop_y = texture_location['textureIndexOnAtlas'] * BLOCK_WIDTH
                    crop_box = (0, crop_y, BLOCK_WIDTH, crop_y + BLOCK_WIDTH)
                    texture_image = atlas_image.crop(crop_box)
                    avg_color, has_transparency, is_monocolor = analyze_texture(texture_image)
                    processed_textures[texture_unique_key] = {
                        "avg_color": avg_color,
                        "has_transparency": has_transparency,
                        "is_monocolor": is_monocolor
                    }

                face_palette.append({
                    "blockId": int(block_id),
                    "face_key": face_key,
                    **processed_textures[texture_unique_key]
                })

    with open(CACHE_OUTPUT_PATH, 'w') as f:
        json.dump(face_palette, f, indent=2)
        
    print(f"Filtered out {slab_count} slab blocks.")
    print(f"Successfully generated face palette with {len(face_palette)} entries.")
    print(f"Cache saved to: {CACHE_OUTPUT_PATH}")

if __name__ == '__main__':
    main()