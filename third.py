import json
from PIL import Image, ImageDraw
import math
import os

INPUT_IMAGE_PATH = 'dog_standing_on_4_water_bottles.jpg'

MAX_HEIGHT = 96 # The maximum height in blocks for the output. Width will be scaled automatically.

# The direction the player will be looking from. This determines which block face is used.
# Options: "face_0_Right_PlusX", "face_1_Left_MinusX", "face_4_Front_PlusZ", "face_5_Back_MinusZ"
VIEWING_DIRECTION = "face_1_Left_MinusX" # This is the standard "front" face.


PREFER_MONO_COLORS = True
NO_TRANSPARENT_BLOCKS = True
MONO_COLOR_THRESHOLD = 300.0
COLOR_CACHE_PATH = 'block_color_cache.json'
BLOCK_TEXTURE_MAP_PATH = 'block_texture_map.json'
ATLAS_PREFIX = 'texture_atlas_'
ATLAS_EXTENSION = '.png'
BLOCK_WIDTH = 8

try:
    RESAMPLING_FILTER = Image.Resampling.NEAREST
except AttributeError:
    RESAMPLING_FILTER = Image.NEAREST

def color_distance(c1, c2):
    return math.sqrt((c1[0] - c2[0])**2 + (c1[1] - c2[1])**2 + (c1[2] - c2[2])**2)

def find_closest_block_id(pixel_color, available_faces, prefer_mono, mono_threshold):
    best_overall_id, min_overall_distance = -1, float('inf')
    best_mono_id, min_mono_distance = -1, float('inf')

    for face_data in available_faces:
        distance = color_distance(pixel_color, tuple(face_data['avg_color']))
        if distance < min_overall_distance:
            min_overall_distance = distance
            best_overall_id = face_data['blockId']
        if prefer_mono and face_data.get("is_monocolor", False) and distance < min_mono_distance:
            min_mono_distance = distance
            best_mono_id = face_data['blockId']
    
    if prefer_mono and best_mono_id != -1 and min_mono_distance <= mono_threshold:
        return best_mono_id
    return best_overall_id

def create_texture_preview(block_id_array, block_texture_map, atlas_images, viewing_direction):
    height, width = len(block_id_array), len(block_id_array[0])
    preview_image = Image.new('RGB', (width * BLOCK_WIDTH, height * BLOCK_WIDTH))
    
    face_key_to_render = viewing_direction

    print(f"Stitching textures for preview using '{face_key_to_render}'...")
    for y, row in enumerate(block_id_array):
        for x, block_id in enumerate(row):
            block_data = block_texture_map.get(str(block_id))
            if block_data:
                palette_index = block_data['faceMap'].get(face_key_to_render)
                if palette_index is not None:
                    texture_location = block_data['texturePalette'][palette_index]
                    atlas_image = atlas_images[texture_location['atlasFileIndex']]
                    
                    crop_y = texture_location['textureIndexOnAtlas'] * BLOCK_WIDTH
                    crop_box = (0, crop_y, BLOCK_WIDTH, crop_y + BLOCK_WIDTH)
                    texture_tile = atlas_image.crop(crop_box)
                    
                    preview_image.paste(texture_tile, (x * BLOCK_WIDTH, y * BLOCK_WIDTH))
    return preview_image

def main():
    base_name, _ = os.path.splitext(INPUT_IMAGE_PATH)
    output_json_path = f"{base_name}_blocks.json"
    output_preview_path = f"{base_name}_preview.png"

    print(f"Converting '{INPUT_IMAGE_PATH}' for viewing direction: {VIEWING_DIRECTION}")

    try:
        with open(COLOR_CACHE_PATH, 'r') as f:
            face_palette = json.load(f)
        with open(BLOCK_TEXTURE_MAP_PATH, 'r') as f:
            block_texture_map = json.load(f)
        
        atlas_images = []
        i = 0
        while os.path.exists(f"{ATLAS_PREFIX}{i}{ATLAS_EXTENSION}"):
            atlas_images.append(Image.open(f"{ATLAS_PREFIX}{i}{ATLAS_EXTENSION}"))
            i += 1
        if not atlas_images:
            raise FileNotFoundError("No texture atlas files found.")
            
    except FileNotFoundError as e:
        print(f"Error: A required file is missing: {e}")
        return

    available_faces = [
        face for face in face_palette
        if face['face_key'] == VIEWING_DIRECTION and \
           (not NO_TRANSPARENT_BLOCKS or not face.get("has_transparency", False))
    ]
    print(f"Found {len(available_faces)} available block faces for the '{VIEWING_DIRECTION}' direction.")

    try:
        image = Image.open(INPUT_IMAGE_PATH).convert('RGB')
        
        original_width, original_height = image.size
        if original_height > MAX_HEIGHT:
            aspect_ratio = original_width / original_height
            new_height = MAX_HEIGHT
            new_width = int(new_height * aspect_ratio)
            print(f"Resizing image from {original_width}x{original_height} to {new_width}x{new_height}...")
            resized_image = image.resize((new_width, new_height), RESAMPLING_FILTER)
        else:
            print(f"Image height ({original_height}px) is within the limit. Using original dimensions.")
            resized_image = image

        width, height = resized_image.size
        pixels = resized_image.load()
    except FileNotFoundError:
        print(f"Error: Input image not found at '{INPUT_IMAGE_PATH}'.")
        return

    output_array = []
    for y in range(height):
        row = []
        for x in range(width):
            pixel_color = pixels[x, y]
            closest_block_id = find_closest_block_id(pixel_color, available_faces, PREFER_MONO_COLORS, MONO_COLOR_THRESHOLD)
            row.append(closest_block_id)
        output_array.append(row)
        print(f"Processing row {y + 1}/{height}...")

    with open(output_json_path, 'w') as f:
        json.dump(output_array, f)
    print(f"\nBlock ID array saved to '{output_json_path}'.")

    preview_image = create_texture_preview(output_array, block_texture_map, atlas_images, VIEWING_DIRECTION)
    preview_image.save(output_preview_path)
    print(f"High-fidelity preview image saved to '{output_preview_path}'.")
    
    print("\nConversion complete!")

if __name__ == '__main__':
    main()