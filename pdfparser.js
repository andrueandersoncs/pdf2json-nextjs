const fs = require("fs"),
    {EventEmitter} = require("events"),
	nodeUtil = require("util"),
    _ = require("lodash"),
    async = require("async"),
	PDFJS = require("./lib/pdf.js"),
    {ParserStream} = require("./lib/parserstream");


class PDFParser extends EventEmitter { // inherit from event emitter
    //private static
    static #nextId = 0;
    static #maxBinBufferCount = 10;
    static #binBuffer = {};

    //private
    #id = 0;    
    #password = "";

    #context = null; // service context object, only used in Web Service project; null in command line
    #fq = null; //async queue for reading files
    
    #pdfFilePath = null; //current PDF file to load and parse, null means loading/parsing not started
    #pdfFileMTime = null; // last time the current pdf was modified, used to recognize changes and ignore cache
    #data = null; //if file read success, data is PDF content; if failed, data is "err" object
    #PDFJS = null; //will be initialized in constructor
    #processFieldInfoXML = false;//disable additional _fieldInfo.xml parsing and merging (do NOT set to true)

    // constructor
    constructor(context, needRawText, password) {
        //call constructor for super class
        super();
    
        // private
        this.#id = PDFParser.#nextId++;

        // service context object, only used in Web Service project; null in command line
        this.#context = context;
        this.#fq = async.queue( (task, callback) => {
            fs.readFile(task.path, callback);
        }, 1);

        this.#pdfFilePath = null; //current PDF file to load and parse, null means loading/parsing not started
        this.#pdfFileMTime = null; // last time the current pdf was modified, used to recognize changes and ignore cache
        this.#data = null; //if file read success, data is PDF content; if failed, data is "err" object
        this.#processFieldInfoXML = false;//disable additional _fieldInfo.xml parsing and merging (do NOT set to true)

        this.#PDFJS = new PDFJS(needRawText);
        this.#password = password;
    } 
    
    get id() { return this.#id; }
    get name() { return `${PDFParser.name}_${this.#id}`; }
    get data() { return this.#data; }
    get binBufferKey() { return this.#pdfFilePath + this.#pdfFileMTime; }

	//private methods, needs to invoked by [funcName].call(this, ...)
	#onPDFJSParseDataReady(data) {
		if (!data) { //v1.1.2: data===null means end of parsed data
			nodeUtil.p2jinfo("PDF parsing completed.");
			const output = {"formImage": this.#data};
			this.emit("pdfParser_dataReady", output);
		}
		else {
			this.#data = {...this.#data, ...data};            
		}
	}

	#onPDFJSParserDataError(data) {
		this.#data = null;
		this.emit("pdfParser_dataError", {"parserError": data});
	}

	#startParsingPDF(buffer) {
		this.#data = {};

		this.#PDFJS.on("pdfjs_parseDataReady", this.#onPDFJSParseDataReady.bind(this));
		this.#PDFJS.on("pdfjs_parseDataError", this.#onPDFJSParserDataError.bind(this));

        // this.#PDFJS.on("readable", meta => console.log("readable", meta));
        // this.#PDFJS.on("data", data => console.log("data", data));
        // this.#PDFJS.on("error", err => console.log("error", err));    

		this.#PDFJS.parsePDFData(buffer || PDFParser.#binBuffer[this.binBufferKey], this.#password);
	}

	#processBinaryCache() {
		if (_.has(PDFParser.#binBuffer, this.binBufferKey)) {
			this.#startParsingPDF();
			return true;
		}

		const allKeys = _.keys(PDFParser.#binBuffer);
		if (allKeys.length > PDFParser.#maxBinBufferCount) {
			const idx = this.id % PDFParser.#maxBinBufferCount;
			const key = allKeys[idx];
			PDFParser.#binBuffer[key] = null;
			delete PDFParser.#binBuffer[key];

			nodeUtil.p2jinfo("re-cycled cache for " + key);
		}

		return false;
	}

	#processPDFContent(err, data) {
		nodeUtil.p2jinfo("Load PDF file status:" + (!!err ? "Error!" : "Success!") );
		if (err) {
			this.#data = null;
			this.emit("pdfParser_dataError", err);
		}
		else {
			PDFParser.#binBuffer[this.binBufferKey] = data;
			this.#startParsingPDF();
		}
	};

	//public APIs
    createParserStream() {
        return new ParserStream(this, {objectMode: true, bufferSize: 64 * 1024});
    }

	loadPDF(pdfFilePath, verbosity) {
		nodeUtil.verbosity(verbosity || 0);
		nodeUtil.p2jinfo("about to load PDF file " + pdfFilePath);

		this.#pdfFilePath = pdfFilePath;
		this.#pdfFileMTime = fs.statSync(pdfFilePath).mtimeMs;
		if (this.#processFieldInfoXML) {
			this.#PDFJS.tryLoadFieldInfoXML(pdfFilePath);
		}

		if (this.#processBinaryCache())
			return;

		this.#fq.push({path: pdfFilePath}, this.#processPDFContent.bind(this));
	}

	// Introduce a way to directly process buffers without the need to write it to a temporary file
	parseBuffer(pdfBuffer) {
		this.#startParsingPDF(pdfBuffer);
	}

	getRawTextContent() { return this.#PDFJS.getRawTextContent(); }
	getRawTextContentStream() { return ParserStream.createContentStream(this.getRawTextContent()); }

	getAllFieldsTypes() { return this.#PDFJS.getAllFieldsTypes(); };
	getAllFieldsTypesStream() { return ParserStream.createContentStream(this.getAllFieldsTypes()); }

	getMergedTextBlocksIfNeeded() { return {"formImage": this.#PDFJS.getMergedTextBlocksIfNeeded()}; }
	getMergedTextBlocksStream() { return ParserStream.createContentStream(this.getMergedTextBlocksIfNeeded()) }

	destroy() { // invoked with stream transform process		
        super.removeAllListeners();

		//context object will be set in Web Service project, but not in command line utility
		if (this.#context) {
			this.#context.destroy();
			this.#context = null;
		}

		this.#pdfFilePath = null;
		this.#pdfFileMTime = null;
		this.#data = null;
        this.#processFieldInfoXML = false;//disable additional _fieldInfo.xml parsing and merging (do NOT set to true)

        this.#PDFJS.destroy();
        this.#PDFJS = null;
	}
}

module.exports = PDFParser;

