#import <AppKit/AppKit.h>
#import <PDFKit/PDFKit.h>
#import <CoreGraphics/CoreGraphics.h>
#include <math.h>
#include <stdint.h>

// 0 = success, 1 = unreadable, 2 = locked, 3 = empty/too large, 4 = conversion failed.
int32_t shift_pdf_info(const char *source, size_t *pages) {
    @autoreleasepool {
        @try {
            PDFDocument *document = [[PDFDocument alloc] initWithURL:[NSURL fileURLWithPath:[NSString stringWithUTF8String:source]]];
            if (!document) return 1;
            if (document.isLocked) return 2;
            if (document.pageCount == 0) return 3;
            *pages = document.pageCount;
            return 0;
        } @catch (NSException *exception) { return 1; }
    }
}

int32_t shift_pdf_render(const char *source, const char *folder, size_t count) {
    @autoreleasepool {
        @try {
            PDFDocument *document = [[PDFDocument alloc] initWithURL:[NSURL fileURLWithPath:[NSString stringWithUTF8String:source]]];
            if (!document) return 1;
            if (document.isLocked) return 2;
            if (document.pageCount != count || count == 0) return 3;
            NSString *directory = [NSString stringWithUTF8String:folder];
            for (size_t index = 0; index < count; ++index) {
                @autoreleasepool {
                    PDFPage *page = [document pageAtIndex:index];
                    NSRect bounds = [page boundsForBox:kPDFDisplayBoxCropBox];
                    double width = bounds.size.width * 2.0;
                    double height = bounds.size.height * 2.0;
                    if (page.rotation % 180 != 0) { double swap = width; width = height; height = swap; }
                    if (!isfinite(width) || !isfinite(height) || width < 1 || height < 1) return 3;
                    double scale = fmin(1.0, fmin(8192.0 / width, 8192.0 / height));
                    width = ceil(width * scale);
                    height = ceil(height * scale);
                    if (width * height > 40000000.0) return 3;
                    NSImage *image = [page thumbnailOfSize:NSMakeSize(width, height) forBox:kPDFDisplayBoxCropBox];
                    if (!image) return 4;
                    NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithData:image.TIFFRepresentation];
                    NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
                    if (!png) return 4;
                    NSString *path = [directory stringByAppendingPathComponent:[NSString stringWithFormat:@"page-%04zu.png", index + 1]];
                    if (![png writeToFile:path atomically:YES]) return 4;
                }
            }
            return 0;
        } @catch (NSException *exception) { return 4; }
    }
}

int32_t shift_images_to_pdf(const char *const *sources, size_t count, const char *destination) {
    @autoreleasepool {
        if (count == 0 || count > 200) return 3;
        CGContextRef context = NULL;
        int32_t result = 0;
        @try {
            NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:destination]];
            context = CGPDFContextCreateWithURL((__bridge CFURLRef)url, NULL, NULL);
            if (!context) return 4;
            for (size_t index = 0; index < count; ++index) {
                @autoreleasepool {
                    NSImage *image = [[NSImage alloc] initWithContentsOfFile:[NSString stringWithUTF8String:sources[index]]];
                    if (!image) { result = 1; break; }
                    NSSize size = image.size;
                    if (!isfinite(size.width) || !isfinite(size.height) || size.width < 1 || size.height < 1) {
                        result = 3; break;
                    }
                    // Keep a photo's full pixels, but fit its physical page
                    // within 11 inches so it opens and prints sensibly.
                    double scale = fmin(1.0, 792.0 / fmax(size.width, size.height));
                    CGRect mediaBox = CGRectMake(0, 0, size.width * scale, size.height * scale);
                    CGContextBeginPage(context, &mediaBox);
                    NSGraphicsContext *graphics = [NSGraphicsContext graphicsContextWithCGContext:context flipped:NO];
                    [NSGraphicsContext saveGraphicsState];
                    [NSGraphicsContext setCurrentContext:graphics];
                    [image drawInRect:NSRectFromCGRect(mediaBox) fromRect:NSZeroRect
                            operation:NSCompositingOperationSourceOver fraction:1.0];
                    [NSGraphicsContext restoreGraphicsState];
                    CGContextEndPage(context);
                }
            }
            if (result == 0) CGPDFContextClose(context);
        } @catch (NSException *exception) {
            result = 4;
        } @finally {
            if (context) CGContextRelease(context);
        }
        return result;
    }
}
