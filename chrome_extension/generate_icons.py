import os
from PIL import Image, ImageDraw

def create_icons():
    os.makedirs("icons", exist_ok=True)
    sizes = [16, 48, 128]
    
    for size in sizes:
        img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        
        # Rounded background
        margin = int(size * 0.08)
        radius = int(size * 0.25)
        # Blue gradient-like solid circle/rounded rect
        draw.rounded_rectangle(
            [margin, margin, size - margin, size - margin],
            radius=radius,
            fill=(37, 99, 235, 255) # Blue-600
        )
        
        # Draw SMS bubble / message icon
        pad = int(size * 0.28)
        draw.rounded_rectangle(
            [pad, pad, size - pad, size - int(pad * 1.3)],
            radius=int(radius * 0.5),
            fill=(255, 255, 255, 255)
        )
        # Speech triangle
        tri = [
            (int(size * 0.35), size - int(pad * 1.3)),
            (int(size * 0.35), size - int(pad * 0.9)),
            (int(size * 0.52), size - int(pad * 1.3))
        ]
        draw.polygon(tri, fill=(255, 255, 255, 255))
        
        img.save(f"icons/icon-{size}.png", "PNG")
        print(f"Generated icons/icon-{size}.png")

if __name__ == "__main__":
    create_icons()
