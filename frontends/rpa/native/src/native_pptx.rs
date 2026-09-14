use std::io::Write;
use std::path::Path;
use zip::write::SimpleFileOptions;

#[derive(Debug)]
struct Slide {
    title: String,
    lines: Vec<(String, bool)>,
}

fn escape_xml(value: &str) -> String {
    value
        .chars()
        .filter(|character| {
            matches!(*character, '\u{9}' | '\u{A}' | '\u{D}') || *character >= '\u{20}'
        })
        .collect::<String>()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn parse_slides(title: &str, content: &str) -> Vec<Slide> {
    let mut groups = vec![Vec::<String>::new()];
    for line in content.lines() {
        if line.trim() == "---" {
            if groups.last().is_some_and(|group| !group.is_empty()) {
                groups.push(Vec::new());
            }
        } else {
            groups.last_mut().unwrap().push(line.to_string());
        }
    }
    groups
        .into_iter()
        .filter(|group| group.iter().any(|line| !line.trim().is_empty()))
        .enumerate()
        .map(|(index, group)| {
            let mut slide_title = String::new();
            let mut lines = Vec::new();
            for line in group {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if slide_title.is_empty() {
                    if let Some(value) = trimmed
                        .strip_prefix("# ")
                        .or_else(|| trimmed.strip_prefix("## "))
                        .or_else(|| trimmed.strip_prefix("### "))
                    {
                        slide_title = value.trim().to_string();
                        continue;
                    }
                }
                let bullet = trimmed.starts_with("- ") || trimmed.starts_with("* ");
                let text = if bullet { &trimmed[2..] } else { trimmed };
                lines.push((text.to_string(), bullet));
            }
            if slide_title.is_empty() {
                slide_title = if index == 0 {
                    title.to_string()
                } else {
                    format!("{title} {}", index + 1)
                };
            }
            Slide {
                title: slide_title,
                lines,
            }
        })
        .collect()
}

fn paragraph(text: &str, size: u32, bold: bool, bullet: bool, color: &str) -> String {
    let bullet_xml = if bullet {
        "<a:buChar char=\"•\"/>"
    } else {
        "<a:buNone/>"
    };
    format!(
        "<a:p><a:pPr marL=\"{}\" indent=\"{}\">{bullet_xml}</a:pPr><a:r><a:rPr lang=\"zh-CN\" sz=\"{size}\" b=\"{}\"><a:solidFill><a:srgbClr val=\"{color}\"/></a:solidFill><a:latin typeface=\"Arial Unicode MS\"/><a:ea typeface=\"Arial Unicode MS\"/></a:rPr><a:t>{}</a:t></a:r><a:endParaRPr lang=\"zh-CN\" sz=\"{size}\"/></a:p>",
        if bullet { 342_900 } else { 0 },
        if bullet { -228_600 } else { 0 },
        u8::from(bold),
        escape_xml(text),
    )
}

fn text_shape(
    id: usize,
    name: &str,
    position: (i64, i64),
    size: (i64, i64),
    paragraphs: &str,
) -> String {
    format!(
        "<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"{}\"/><p:cNvSpPr txBox=\"1\"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x=\"{}\" y=\"{}\"/><a:ext cx=\"{}\" cy=\"{}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap=\"square\" anchor=\"t\"/><a:lstStyle/>{paragraphs}</p:txBody></p:sp>",
        escape_xml(name),
        position.0,
        position.1,
        size.0,
        size.1,
    )
}

fn slide_xml(slide: &Slide, index: usize) -> String {
    let title = paragraph(&slide.title, 3000, true, false, "17324D");
    let body = if slide.lines.is_empty() {
        paragraph("", 1800, false, false, "263247")
    } else {
        slide
            .lines
            .iter()
            .map(|(text, bullet)| paragraph(text, 1800, false, *bullet, "263247"))
            .collect::<String>()
    };
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><p:sld xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val=\"F7F3E8\"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id=\"2\" name=\"Accent {index}\"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"228600\" cy=\"6858000\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val=\"E15C38\"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>{}{}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>",
        text_shape(3, "Title", (685_800, 685_800), (10_820_400, 1_143_000), &title),
        text_shape(4, "Body", (914_400, 2_057_400), (10_287_000, 3_886_200), &body),
    )
}

fn write_entry(
    archive: &mut zip::ZipWriter<std::fs::File>,
    options: SimpleFileOptions,
    name: impl AsRef<str>,
    body: impl AsRef<[u8]>,
) -> Result<(), String> {
    archive
        .start_file(name.as_ref(), options)
        .map_err(|error| error.to_string())?;
    archive
        .write_all(body.as_ref())
        .map_err(|error| error.to_string())
}

pub(crate) fn write_pptx(
    output: &Path,
    title: &str,
    author: &str,
    content: &str,
) -> Result<(), String> {
    let slides = parse_slides(title, content);
    if slides.is_empty() {
        return Err("PPTX content must contain at least one slide".into());
    }
    let file = std::fs::File::create(output)
        .map_err(|error| format!("create {}: {error}", output.display()))?;
    let mut archive = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let overrides = (1..=slides.len()).map(|index| format!("<Override PartName=\"/ppt/slides/slide{index}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slide+xml\"/>")).collect::<String>();
    write_entry(&mut archive, options, "[Content_Types].xml", format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/ppt/presentation.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml\"/><Override PartName=\"/ppt/slideMasters/slideMaster1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml\"/><Override PartName=\"/ppt/slideLayouts/slideLayout1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml\"/><Override PartName=\"/ppt/theme/theme1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.theme+xml\"/><Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/><Override PartName=\"/docProps/app.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.extended-properties+xml\"/>{overrides}</Types>"))?;
    write_entry(&mut archive, options, "_rels/.rels", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"ppt/presentation.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/><Relationship Id=\"rId3\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties\" Target=\"docProps/app.xml\"/></Relationships>")?;
    write_entry(&mut archive, options, "docProps/core.xml", format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:title>{}</dc:title><dc:creator>{}</dc:creator></cp:coreProperties>", escape_xml(title), escape_xml(author)))?;
    write_entry(&mut archive, options, "docProps/app.xml", format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\"><Application>ClawMaster Rust</Application><Slides>{}</Slides></Properties>", slides.len()))?;
    let slide_ids = (1..=slides.len())
        .map(|index| {
            format!(
                "<p:sldId id=\"{}\" r:id=\"rId{}\"/>",
                255 + index,
                index + 1
            )
        })
        .collect::<String>();
    write_entry(&mut archive, options, "ppt/presentation.xml", format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><p:presentation xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"><p:sldMasterIdLst><p:sldMasterId id=\"2147483648\" r:id=\"rId1\"/></p:sldMasterIdLst><p:sldIdLst>{slide_ids}</p:sldIdLst><p:sldSz cx=\"12192000\" cy=\"6858000\" type=\"screen16x9\"/><p:notesSz cx=\"6858000\" cy=\"9144000\"/><p:defaultTextStyle/></p:presentation>"))?;
    let relationships = (1..=slides.len()).map(|index| format!("<Relationship Id=\"rId{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slides/slide{index}.xml\"/>", index + 1)).collect::<String>();
    write_entry(&mut archive, options, "ppt/_rels/presentation.xml.rels", format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster\" Target=\"slideMasters/slideMaster1.xml\"/>{relationships}</Relationships>"))?;
    write_entry(
        &mut archive,
        options,
        "ppt/slideMasters/slideMaster1.xml",
        include_str!("pptx/slideMaster1.xml"),
    )?;
    write_entry(
        &mut archive,
        options,
        "ppt/slideMasters/_rels/slideMaster1.xml.rels",
        include_str!("pptx/slideMaster1.xml.rels"),
    )?;
    write_entry(
        &mut archive,
        options,
        "ppt/slideLayouts/slideLayout1.xml",
        include_str!("pptx/slideLayout1.xml"),
    )?;
    write_entry(
        &mut archive,
        options,
        "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
        include_str!("pptx/slideLayout1.xml.rels"),
    )?;
    write_entry(
        &mut archive,
        options,
        "ppt/theme/theme1.xml",
        include_str!("pptx/theme1.xml"),
    )?;
    for (index, slide) in slides.iter().enumerate() {
        write_entry(
            &mut archive,
            options,
            format!("ppt/slides/slide{}.xml", index + 1),
            slide_xml(slide, index + 1),
        )?;
        write_entry(
            &mut archive,
            options,
            format!("ppt/slides/_rels/slide{}.xml.rels", index + 1),
            include_str!("pptx/slide.xml.rels"),
        )?;
    }
    archive.finish().map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_markdown_into_separate_slides() {
        let slides = parse_slides("Deck", "# One\n- A\n---\n# Two\nB");
        assert_eq!(slides.len(), 2);
        assert_eq!(slides[0].title, "One");
        assert_eq!(slides[0].lines, vec![("A".to_string(), true)]);
        assert_eq!(slides[1].title, "Two");
    }
}
