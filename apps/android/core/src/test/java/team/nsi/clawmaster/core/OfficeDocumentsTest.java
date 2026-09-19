package team.nsi.clawmaster.core;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import static org.junit.Assert.*;

/** Uses the shipped shaded Office runtime, real containers and immutable stored revisions. */
public final class OfficeDocumentsTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test public void wordSpreadsheetAndSlidesRoundTripTextEdits() throws Exception {
        for (String format : new String[]{"docx", "xlsx", "pptx", "txt", "md", "csv"}) {
            byte[] original = OfficeDocuments.create(format, "Quarterly report");
            JSONArray units = OfficeDocuments.read(format, original);
            assertEquals("Quarterly report", units.getJSONObject(0).getString("text"));
            byte[] changed = OfficeDocuments.edit(format, original, new JSONArray().put(new JSONObject()
                .put("key", units.getJSONObject(0).getString("key")).put("text", "Reviewed report")));
            assertEquals("Reviewed report", OfficeDocuments.read(format, changed).getJSONObject(0).getString("text"));
            assertEquals("Quarterly report", OfficeDocuments.read(format, original).getJSONObject(0).getString("text"));
        }
    }
    @Test public void spreadsheetChangesAreLiteralAndOtherCellsSurvive() throws Exception {
        byte[] original = OfficeDocuments.create("xlsx", "Owner\tAmount\nAlice\t12");
        byte[] changed = OfficeDocuments.edit("xlsx", original, new JSONArray().put(new JSONObject().put("key", "s:0:A2").put("text", "=1+1")));
        try (org.apache.poi.xssf.usermodel.XSSFWorkbook book = new org.apache.poi.xssf.usermodel.XSSFWorkbook(new java.io.ByteArrayInputStream(changed))) {
            assertEquals(org.apache.poi.ss.usermodel.CellType.STRING, book.getSheetAt(0).getRow(1).getCell(0).getCellType());
            assertEquals("=1+1", book.getSheetAt(0).getRow(1).getCell(0).getStringCellValue());
            assertEquals("12", book.getSheetAt(0).getRow(1).getCell(1).getStringCellValue());
        }
    }
    @Test public void slidesContainValidPositionedTextAndSeparateParagraphs() throws Exception {
        byte[] bytes = OfficeDocuments.create("pptx", "Title\nBody\fNext slide");
        try (org.apache.poi.xslf.usermodel.XMLSlideShow slides = new org.apache.poi.xslf.usermodel.XMLSlideShow(new java.io.ByteArrayInputStream(bytes))) {
            assertEquals(2, slides.getSlides().size());
            for (org.apache.poi.xslf.usermodel.XSLFSlide slide : slides.getSlides()) {
                java.util.List<org.apache.xmlbeans.XmlError> errors = new java.util.ArrayList<>();
                assertTrue(errors.toString(), slide.getXmlObject().validate(new org.apache.xmlbeans.XmlOptions().setErrorListener(errors)));
                org.openxmlformats.schemas.presentationml.x2006.main.CTShape shape = slide.getXmlObject().getCSld().getSpTree().getSpArray(0);
                assertEquals(648L * 12700, shape.getSpPr().getXfrm().getExt().getCx());
                assertEquals(2000, shape.getTxBody().getPArray(0).getRArray(0).getRPr().getSz());
            }
        }
        JSONArray units = OfficeDocuments.read("pptx", bytes);
        assertEquals(3, units.length());
        assertEquals("Body", units.getJSONObject(1).getString("text"));
        assertEquals("Next slide", units.getJSONObject(2).getString("text"));
    }
    @Test public void concurrentDocumentEditRejectsStaleRevisionAndRetainsOriginalBytes() throws Exception {
        Path root = temporary.newFolder().toPath();
        DocumentStore store = new DocumentStore(root);
        byte[] original = OfficeDocuments.create("docx", "Original");
        JSONObject file = store.importFile("report.docx", original);
        JSONObject edit = new JSONObject().put("id", file.getString("id")).put("expectedRevision", file.getString("revision"))
            .put("changes", new JSONArray().put(new JSONObject().put("key", "p:0").put("text", "Reviewed")));
        store.edit(edit);
        assertEquals("revision_conflict", assertThrows(IOException.class, () -> store.edit(edit)).getMessage());
        assertEquals("Reviewed", store.read(file.getString("id")).getJSONArray("units").getJSONObject(0).getString("text"));
        assertArrayEquals(original, Files.readAllBytes(root.resolve(file.getString("revision") + ".bin")));
        assertEquals(2, new DocumentStore(root).metadata(file.getString("id")).getJSONArray("revisions").length());
    }
    @Test public void malformedUnsupportedAndOversizedDocumentsDoNotEnterTheStore() throws Exception {
        DocumentStore store = new DocumentStore(temporary.newFolder().toPath());
        assertThrows(Exception.class, () -> store.importFile("broken.docx", new byte[]{1, 2, 3}));
        assertThrows(Exception.class, () -> store.importFile("macro.docm", new byte[]{1}));
        assertThrows(Exception.class, () -> store.importFile("../outside.txt", new byte[]{1}));
        assertThrows(Exception.class, () -> store.importFile("huge.txt", new byte[OfficeDocuments.MAX_FILE_BYTES + 1]));
        assertEquals(0, store.list().length());
    }
    @Test public void unknownOrDuplicatedEditTargetsCannotProduceAnUpdatedFile() throws Exception {
        byte[] original = OfficeDocuments.create("docx", "Before");
        JSONObject change = new JSONObject().put("key", "p:0").put("text", "After");
        assertThrows(Exception.class, () -> OfficeDocuments.edit("docx", original, new JSONArray().put(change).put(change)));
        assertThrows(Exception.class, () -> OfficeDocuments.edit("docx", original, new JSONArray().put(new JSONObject().put("key", "p:99").put("text", "No"))));
        assertEquals("Before", OfficeDocuments.read("docx", original).getJSONObject(0).getString("text"));
    }
}
