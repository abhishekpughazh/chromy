import os
import sys
import torch
from PIL import Image
from realesrgan import RealESRGANer
from basicsr.archs.rrdbnet_arch import RRDBNet
import cv2
import numpy as np

def upscale_image(input_path: str, output_path: str, weights_path: str = "RealESRGAN_x4plus.pth", tile: int = 512, tile_pad: int = 10):
    """Upscale a single image to 4x using RealESRGAN."""
    
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    print(f"[UPSCALE] Using device: {device}", file=sys.stderr)

    model = RRDBNet(
        num_in_ch=3,
        num_out_ch=3,
        num_feat=64,
        num_block=23,
        num_grow_ch=32,
        scale=4
    )

    upsampler = RealESRGANer(
        scale=4,
        model_path=weights_path,
        model=model,
        tile=tile,
        tile_pad=tile_pad,
        pre_pad=0,
        half=torch.cuda.is_available()
    )

    # Load + optional CLAHE preprocessing
    img_cv = cv2.imread(input_path)
    if img_cv is None:
        raise ValueError(f"Could not read image: {input_path}")

    gray = cv2.cvtColor(img_cv, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8,8))
    gray = clahe.apply(gray)
    img = Image.fromarray(gray).convert("RGB")

    # Super resolution
    img_np = np.array(img)
    sr_np, _ = upsampler.enhance(img_np, outscale=4)
    sr = Image.fromarray(sr_np)

    # Save
    sr.save(output_path)
    print(f"[UPSCALE] Saved 4K image to: {output_path}")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 upscale_single.py <input_path> <output_path> [weights_path]", file=sys.stderr)
        sys.exit(1)
    
    in_path = sys.argv[1]
    out_path = sys.argv[2]
    weights = sys.argv[3] if len(sys.argv) > 3 else "RealESRGAN_x4plus.pth"
    
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    upscale_image(in_path, out_path, weights)
