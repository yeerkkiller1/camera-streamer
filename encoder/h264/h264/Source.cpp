#include <cstdio>
#include <string>
#include <fstream>

#include <codec_api.h>
#include <codec_app_def.h>
#include <codec_def.h>
#include <codec_ver.h>

// https://adrianhenke.wordpress.com/2008/12/05/create-lib-file-from-dll/
// https://github.com/cisco/openh264/wiki/UsageExampleForEncoder#encoder-usage-example-1

// https://cardinalpeak.com/blog/worlds-smallest-h-264-encoder/
// https://cardinalpeak.com/blog/the-h-264-sequence-parameter-set/

// https://github.com/cisco/openh264/wiki/TypesAndStructures

// https://www.itu.int/rec/T-REC-H.264-201704-I/en ("C:\Users\quent\Downloads\T-REC-H.264-201704-I!!PDF-E.pdf")

// https://stackoverflow.com/questions/9296059/read-pixel-value-in-bmp-file


//https://stackoverflow.com/questions/49397904/muxing-h264-into-mp4-using-libmp4v2-and-openh264
void prepareFrame(int i, SSourcePicture* pic, int width, int height) {

	std::ifstream file("C:/Users/quent/Dropbox/camera/encoder/frame1.bmp", std::ios::binary);
	std::string content((std::istreambuf_iterator<char>(file)), (std::istreambuf_iterator<char>()));
	int length = content.length();
	unsigned char* info = (unsigned char*)content.c_str();

	// extract image height and width from header
	int width2 = *(int*)&info[18];
	int height2 = *(int*)&info[22];

	// BGR format
	// data[((height - y - 1) * width + x) * 3]

	int size = width * height * 3;
	unsigned char* bmp = info + 54;

	printf("R %d, G %d, B %d", (int)bmp[(10 * width + 10) * 3 + 2], (int)bmp[(10 * width + 10) * 3 + 1], (int)bmp[(10 * width + 10) * 3]);

	double Kr = 0.299 * (235 - 16) / 256;
	double Kg = 0.587 * (235 - 16) / 256;
	double Kb = 0.114 * (235 - 16) / 256;

	for (int y = 0; y < height; y++) {
		for (int x = 0; x < width; x++) {
			int R = bmp[((height - y - 1) * width + x) * 3 + 2];
			int G = bmp[((height - y - 1) * width + x) * 3 + 1];
			int B = bmp[((height - y - 1) * width + x) * 3 + 0];
			// http://gentlelogic.blogspot.com/2011/11/exploring-h264-part-1-color-models.html
			// https://community.nxp.com/thread/453796
			int Y = R * 0.299 + G * 0.587 + B * 0.114;
			//Y = 16 + R * 0.257 + G * 0.504 + B * 0.098;
			pic->pData[0][y * width + x] = Y;
		}
	}

	for (int y = 0; y < height; y += 2) {
		for (int x = 0; x < width; x += 2) {
			// XY
			int R00 = bmp[((height - y - 1) * width + x) * 3 + 2];
			int G00 = bmp[((height - y - 1) * width + x) * 3 + 1];
			int B00 = bmp[((height - y - 1) * width + x) * 3 + 0];

			int R01 = bmp[((height - (y + 1) - 1) * width + x) * 3 + 2];
			int G01 = bmp[((height - (y + 1) - 1) * width + x) * 3 + 1];
			int B01 = bmp[((height - (y + 1) - 1) * width + x) * 3 + 0];

			int R10 = bmp[((height - (y + 0) - 1) * width + x + 1) * 3 + 2];
			int G10 = bmp[((height - (y + 0) - 1) * width + x + 1) * 3 + 1];
			int B10 = bmp[((height - (y + 0) - 1) * width + x + 1) * 3 + 0];

			int R11 = bmp[((height - (y + 1) - 1) * width + x + 1) * 3 + 2];
			int G11 = bmp[((height - (y + 1) - 1) * width + x + 1) * 3 + 1];
			int B11 = bmp[((height - (y + 1) - 1) * width + x + 1) * 3 + 0];

			int Y00 = R00 * 0.299 + G00 * 0.587 + B00 * 0.114;
			
			int Cb00 = 128 + -0.168736 * R00 - 0.331264 * G00 + 0.5 * B00;
			int Cr00 = 128 + 0.5 * R00 - 0.418688 * G00 + -0.081312 * B00;

			//Cb00 = 128 + -0.148 * R00 - 0.291 * G00 + 0.439 * B00;
			//Cr00 = 128 + 0.439 * R00 - 0.368 * G00 + -0.071 * B00;

			pic->pData[1][y / 2 * (width / 2) + x / 2] = Cb00;
			pic->pData[2][y / 2 * (width / 2) + x / 2] = Cr00;

			//pic->pData[1][y * (width / 2) + x] = 128 + y + i * 2;
			//pic->pData[2][y * (width / 2) + x] = 64 + x + i * 5;

			/*
			if (x > 100) {
				pic->pData[2][y * (width / 2) + x] = 128;
			}
			*/
			
		}
	}
}

void writeNALUnits(SFrameBSInfo& info, std::ofstream& outputFile) {

	printf("size: %d, frame type %d\n", info.iFrameSizeInBytes, info.eFrameType);
	printf("iLayerNum: %d, uiTimeStamp: %lld\n", info.iLayerNum, info.uiTimeStamp);
	for (int i = 0; i < info.iLayerNum; i++) {
		SLayerBSInfo layerInfo = info.sLayerInfo[i];

		int pos = 0;
		for (int j = 0; j < layerInfo.iNalCount; j++) {
			int len = layerInfo.pNalLengthInByte[j];

			unsigned char* buf = layerInfo.pBsBuf + pos;
			pos += len;

			if (buf[0] != 0) {
				throw "invalid start code";
			}
			if (buf[1] != 0) {
				throw "invalid start code";
			}
			if (buf[2] != 0) {
				throw "invalid start code";
			}
			if (buf[3] != 1) {
				throw "invalid start code";
			}
			len = len - 4;
			char b1 = len >> 24;
			char b2 = len << 8 >> 24;
			char b3 = len << 16 >> 24;
			char b4 = len << 24 >> 24;
			const char lenBytes[4]{ b1, b2, b3, b4 };
			outputFile.write(lenBytes, 4);
			outputFile.write((const char*)buf + 4, len);
		}

		printf("pBsBuf %lld, iNalCount: %d, pNalLengthInByte: %d, eFrameType: %d, sub seq id: %d, uiLayerType: %d, uiQualityId: %d, uiSpatialId: %d, uiTemporalId: %d\n",
			layerInfo.pBsBuf,
			layerInfo.iNalCount,
			*layerInfo.pNalLengthInByte,
			layerInfo.eFrameType,
			layerInfo.iSubSeqId,
			(int)layerInfo.uiLayerType,
			(int)layerInfo.uiQualityId,
			(int)layerInfo.uiSpatialId,
			(int)layerInfo.uiTemporalId
		);
	}
}


void main() {
	//todonext
	// Can we get the encoder to accept RGB values?


		
	ISVCEncoder* encoder;
	int rv = WelsCreateSVCEncoder(&encoder);

	int width = 600;
	int height = 400;

	SEncParamBase param;
	memset(&param, 0, sizeof(SEncParamBase));
	param.iUsageType = (EUsageType)CAMERA_VIDEO_REAL_TIME;
	param.fMaxFrameRate = 10;
	param.iPicWidth = 600;
	param.iPicHeight = 400;
	param.iTargetBitrate = 5000000;
	encoder->Initialize(&param);

	int uiTraceLevel = WELS_LOG_DETAIL;
	encoder->SetOption(ENCODER_OPTION_TRACE_LEVEL, &uiTraceLevel);

	//int add = 0;
	//encoder->SetOption(ENCODER_OPTION_SPS_PPS_ID_STRATEGY, &add);

	// Hmm... only PRO_BASELINE is supported currently...
	//int profile = PRO_CAVLC444;
	//encoder->SetOption(ENCODER_OPTION_PROFILE, &profile);

	int level = LEVEL_2_2;
	encoder->SetOption(ENCODER_OPTION_LEVEL, &level);


	///*

	SFrameBSInfo info;
	memset(&info, 0, sizeof(SFrameBSInfo));
	SSourcePicture pic;
	memset(&pic, 0, sizeof(SSourcePicture));

	pic.iPicWidth = width;
	pic.iPicHeight = height;
	pic.iColorFormat = videoFormatI420;
	pic.iStride[0] = pic.iPicWidth;
	pic.iStride[1] = pic.iStride[2] = pic.iPicWidth / 2;
	
	pic.pData[0] = new unsigned char[width * height];
	pic.pData[1] = new unsigned char[width * height / 2];
	pic.pData[2] = new unsigned char[width * height / 2];
	/*
	pic.pData[0] = data;
	pic.pData[1] = pic.pData[0] + width * height;
	pic.pData[2] = pic.pData[1] + (width * height / 4);
	*/

	printf("start\n");
	for (int num = 0; num < 2; num++) {
		pic.uiTimeStamp = num * 100;

		prepareFrame(num, &pic, width, height);

		//prepare input data
		rv = encoder->EncodeFrame(&pic, &info);

		auto fileName = std::string() + "frame" + std::to_string(num) + ".h264";
		std::ofstream outputFile(fileName, std::ios_base::binary);

		if (rv != cmResultSuccess) {
			throw "failed";
		}

		writeNALUnits(info, outputFile);
	}
	//*/

	/*
	{
		auto fileName = std::string() + "metadata.h264";
		std::ofstream outputFile(fileName, std::ios_base::binary);

		SFrameBSInfo frameInfo;
		encoder->EncodeParameterSets(&frameInfo);
		writeNALUnits(info, outputFile);
	}
	//*/
}