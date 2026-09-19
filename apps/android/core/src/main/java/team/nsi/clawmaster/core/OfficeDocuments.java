package team.nsi.clawmaster.core;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import org.apache.poi.ss.usermodel.Cell;
import org.apache.poi.ss.usermodel.CellType;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.apache.poi.xslf.usermodel.XMLSlideShow;
import org.apache.poi.xslf.usermodel.XSLFShape;
import org.apache.poi.xslf.usermodel.XSLFSlide;
import org.apache.poi.xslf.usermodel.XSLFTextParagraph;
import org.apache.poi.xslf.usermodel.XSLFTextRun;
import org.apache.poi.xslf.usermodel.XSLFTextShape;
import org.apache.poi.xwpf.usermodel.XWPFDocument;
import org.apache.poi.xwpf.usermodel.XWPFParagraph;
import org.apache.poi.xwpf.usermodel.XWPFTable;
import org.apache.poi.xwpf.usermodel.XWPFTableCell;
import org.apache.poi.xwpf.usermodel.XWPFTableRow;
import org.json.JSONArray;
import org.json.JSONObject;

/** Bounded Office text/data edits; drawings, macros and formula evaluation are not executed. */
public final class OfficeDocuments {
    public static final int MAX_FILE_BYTES = 8 * 1024 * 1024;
    static {
        System.setProperty("org.apache.poi.javax.xml.stream.XMLInputFactory", "com.fasterxml.aalto.stax.InputFactoryImpl");
        System.setProperty("org.apache.poi.javax.xml.stream.XMLOutputFactory", "com.fasterxml.aalto.stax.OutputFactoryImpl");
        System.setProperty("org.apache.poi.javax.xml.stream.XMLEventFactory", "com.fasterxml.aalto.stax.EventFactoryImpl");
    }
    private OfficeDocuments() {}

    /** Reject large or ambiguous containers before a document parser allocates its object graph. */
    private static void check(String format, byte[] input) throws Exception {
        if (input.length > MAX_FILE_BYTES) throw new IOException("document_size_limit");
        if (format.equals("txt") || format.equals("md") || format.equals("csv")) return;
        if (!format.equals("docx") && !format.equals("xlsx") && !format.equals("pptx")) throw new IOException("unsupported_document_format");
        int entries = 0, expanded = 0;
        Set<String> names = new HashSet<>();
        try (ZipInputStream zip = new ZipInputStream(new ByteArrayInputStream(input))) {
            ZipEntry entry;
            byte[] buffer = new byte[8192];
            while ((entry = zip.getNextEntry()) != null) {
                if (++entries > 2000 || !names.add(entry.getName()) || entry.getName().contains("..")) throw new IOException("unsafe_document_archive");
                int count;
                while ((count = zip.read(buffer)) != -1) {
                    expanded += count;
                    if (expanded > 32 * 1024 * 1024) throw new IOException("document_expansion_limit");
                }
            }
        }
        if (!names.contains("[Content_Types].xml")) throw new IOException("invalid_office_document");
        if (names.stream().anyMatch(name -> name.toLowerCase(java.util.Locale.ROOT).contains("vbaproject"))) throw new IOException("macros_not_supported");
        if (names.stream().anyMatch(name -> name.startsWith("_xmlsignatures/"))) throw new IOException("signed_documents_not_supported");
    }

    /** Read stable paragraph/cell identifiers for a revision-bound edit proposal. */
    public static JSONArray read(String format, byte[] input) throws Exception {
        check(format, input);
        JSONArray units = new JSONArray();
        visit(format, input, (key, text) -> { add(units, key, text); return null; });
        return units;
    }

    /** Replace only addressed text units; unchanged package parts are retained by Apache POI. */
    public static byte[] edit(String format, byte[] input, JSONArray changes) throws Exception {
        check(format, input);
        if (changes.length() == 0 || changes.length() > 200) throw new IOException("document_edit_limit");
        java.util.Map<String, String> replacements = new java.util.LinkedHashMap<>();
        int total = 0;
        for (int i = 0; i < changes.length(); i++) {
            JSONObject change = changes.getJSONObject(i);
            Json.keys(change, "key", "text");
            String key = Json.text(change, "key", 100), text = Json.text(change, "text", 32768);
            total += text.length();
            if (total > 65536 || replacements.put(key, text) != null) throw new IOException("document_edit_limit");
        }
        byte[] output = visit(format, input, (key, text) -> replacements.remove(key));
        if (!replacements.isEmpty()) throw new IOException("document_unit_not_found");
        check(format, output);
        return output;
    }

    /** Create simple Office files from paragraphs, tab-separated cells or form-feed-separated slides. */
    public static byte[] create(String format, String content) throws Exception {
        if (content.length() > 32768) throw new IOException("document_content_limit");
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        switch (format) {
            case "docx":
                try (XWPFDocument document = new XWPFDocument()) {
                    for (String line : content.split("\n", -1)) document.createParagraph().createRun().setText(line);
                    document.write(output);
                }
                break;
            case "xlsx":
                try (XSSFWorkbook book = new XSSFWorkbook()) {
                    org.apache.poi.xssf.usermodel.XSSFSheet sheet = book.createSheet("Sheet1");
                    String[] rows = content.split("\n", -1);
                    if (rows.length > 1000) throw new IOException("document_unit_limit");
                    for (int r = 0; r < rows.length; r++) {
                        Row row = sheet.createRow(r);
                        String[] cells = rows[r].split("\t", -1);
                        if (cells.length > 100) throw new IOException("document_unit_limit");
                        for (int c = 0; c < cells.length; c++) row.createCell(c).setCellValue(cells[c]);
                    }
                    book.write(output);
                }
                break;
            case "pptx":
                try (XMLSlideShow slides = new XMLSlideShow()) {
                    String[] pages = content.split("\f", -1);
                    if (pages.length > 100) throw new IOException("document_unit_limit");
                    for (String page : pages) {
                        // POI's drawing factory requires desktop AWT; schema objects do not.
                        org.openxmlformats.schemas.presentationml.x2006.main.CTShape shape = slides.createSlide().getXmlObject().getCSld().getSpTree().addNewSp();
                        org.openxmlformats.schemas.presentationml.x2006.main.CTShapeNonVisual visual = shape.addNewNvSpPr();
                        visual.addNewCNvPr().setId(2);
                        visual.getCNvPr().setName("Text");
                        visual.addNewCNvSpPr().setTxBox(true);
                        visual.addNewNvPr();
                        org.openxmlformats.schemas.drawingml.x2006.main.CTShapeProperties properties = shape.addNewSpPr();
                        org.openxmlformats.schemas.drawingml.x2006.main.CTTransform2D transform = properties.addNewXfrm();
                        transform.addNewOff();
                        transform.getOff().setX(36L * 12700); transform.getOff().setY(36L * 12700);
                        transform.addNewExt();
                        transform.getExt().setCx(648L * 12700); transform.getExt().setCy(468L * 12700);
                        properties.addNewPrstGeom().setPrst(org.openxmlformats.schemas.drawingml.x2006.main.STShapeType.RECT);
                        properties.getPrstGeom().addNewAvLst();
                        org.openxmlformats.schemas.drawingml.x2006.main.CTTextBody body = shape.addNewTxBody();
                        body.addNewBodyPr();
                        body.addNewLstStyle();
                        for (String line : page.split("\n", -1)) {
                            org.openxmlformats.schemas.drawingml.x2006.main.CTRegularTextRun run = body.addNewP().addNewR();
                            run.addNewRPr().setSz(2000);
                            run.setT(line);
                        }
                    }
                    slides.write(output);
                }
                break;
            case "txt": case "md": case "csv":
                return content.getBytes(StandardCharsets.UTF_8);
            default: throw new IOException("unsupported_document_format");
        }
        return output.toByteArray();
    }

    private interface Visitor { String text(String key, String value) throws Exception; }

    private static byte[] visit(String format, byte[] input, Visitor visitor) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        switch (format) {
            case "docx":
                try (XWPFDocument document = new XWPFDocument(new ByteArrayInputStream(input))) {
                    for (int p = 0; p < document.getParagraphs().size(); p++) paragraph(document.getParagraphs().get(p), "p:" + p, visitor);
                    for (int t = 0; t < document.getTables().size(); t++) {
                        XWPFTable table = document.getTables().get(t);
                        for (int r = 0; r < table.getRows().size(); r++) {
                            XWPFTableRow row = table.getRow(r);
                            for (int c = 0; c < row.getTableCells().size(); c++) {
                                XWPFTableCell cell = row.getCell(c);
                                for (int p = 0; p < cell.getParagraphs().size(); p++) paragraph(cell.getParagraphs().get(p), "t:" + t + ":" + r + ":" + c + ":" + p, visitor);
                            }
                        }
                    }
                    document.write(output);
                }
                break;
            case "xlsx":
                try (XSSFWorkbook book = new XSSFWorkbook(new ByteArrayInputStream(input))) {
                    int count = 0;
                    for (int s = 0; s < book.getNumberOfSheets(); s++) for (Row row : book.getSheetAt(s)) for (Cell cell : row) {
                        if (++count > 2000) throw new IOException("document_unit_limit");
                        String value = cell.getCellType() == CellType.FORMULA ? "=" + cell.getCellFormula() : cell.toString();
                        String replacement = visitor.text("s:" + s + ":" + cell.getAddress().formatAsString(), value);
                        if (replacement != null) {
                            cell.setBlank();
                            // A model-provided leading '=' remains literal text, never executable formula input.
                            cell.setCellValue(replacement);
                        }
                    }
                    book.write(output);
                }
                break;
            case "pptx":
                try (XMLSlideShow slides = new XMLSlideShow(new ByteArrayInputStream(input))) {
                    for (int s = 0; s < slides.getSlides().size(); s++) {
                        XSLFSlide slide = slides.getSlides().get(s);
                        for (int h = 0; h < slide.getShapes().size(); h++) {
                            XSLFShape shape = slide.getShapes().get(h);
                            if (!(shape instanceof XSLFTextShape)) continue;
                            XSLFTextShape text = (XSLFTextShape) shape;
                            for (int p = 0; p < text.getTextParagraphs().size(); p++) {
                                XSLFTextParagraph paragraph = text.getTextParagraphs().get(p);
                                String replacement = visitor.text("s:" + s + ":h:" + h + ":p:" + p, paragraph.getText());
                                if (replacement == null) continue;
                                java.util.List<XSLFTextRun> runs = paragraph.getTextRuns();
                                if (runs.isEmpty()) paragraph.addNewTextRun().setText(replacement);
                                else for (int r = 0; r < runs.size(); r++) runs.get(r).setText(r == 0 ? replacement : "");
                            }
                        }
                    }
                    slides.write(output);
                }
                break;
            default:
                String text = StandardCharsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(input)).toString();
                String replacement = visitor.text("text", text);
                return replacement == null ? input : replacement.getBytes(StandardCharsets.UTF_8);
        }
        return output.toByteArray();
    }

    private static void paragraph(XWPFParagraph paragraph, String key, Visitor visitor) throws Exception {
        String replacement = visitor.text(key, paragraph.getText());
        if (replacement == null) return;
        while (paragraph.getRuns().size() > 1) paragraph.removeRun(paragraph.getRuns().size() - 1);
        org.apache.poi.xwpf.usermodel.XWPFRun run = paragraph.getRuns().isEmpty() ? paragraph.createRun() : paragraph.getRuns().get(0);
        while (run.getCTR().sizeOfTArray() > 0) run.getCTR().removeT(0);
        run.setText(replacement);
    }
    private static void add(JSONArray units, String key, String text) throws Exception {
        if (units.length() >= 2000 || text.length() > 32768 || units.toString().length() + text.length() > 100000) throw new IOException("document_text_limit");
        units.put(new JSONObject().put("key", key).put("text", text));
    }
}
