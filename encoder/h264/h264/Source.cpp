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

//https://stackoverflow.com/questions/49397904/muxing-h264-into-mp4-using-libmp4v2-and-openh264
void prepareFrame(int i, SSourcePicture* pic, int width, int height) {
	for (int y = 0; y < height; y++) {
		for (int x = 0; x < width; x++) {
			pic->pData[0][y * width + x] = x + y + i * 3;
		}
	}

	for (int y = 0; y < height / 2; y++) {
		for (int x = 0; x < width / 2; x++) {
			pic->pData[1][y * (width / 2) + x] = 128 + y + i * 2;
			pic->pData[2][y * (width / 2) + x] = 64 + x + i * 5;
		}
	}
}

// https://cardinalpeak.com/blog/worlds-smallest-h-264-encoder/

void macroblock(const int i, const int j, int frameNumber, std::ofstream& outputFile)
{
	int x, y;
	if (!((i == 0) && (j == 0)))
	{
		const uint8_t macroblock_header[] = { 0x0d, 0x00 };
		outputFile.write((const char*)&macroblock_header, sizeof(macroblock_header));
	}
	for (x = i * 16; x < (i + 1) * 16; x++)
		for (y = j * 16; y < (j + 1) * 16; y++)
			outputFile.put(x + y + frameNumber * 3);
	for (x = i * 8; x < (i + 1) * 8; x++)
		for (y = j * 8; y < (j + 1) * 8; y++)
			outputFile.put(128 + y + frameNumber * 2);
	for (x = i * 8; x < (i + 1) * 8; x++)
		for (y = j * 8; y < (j + 1) * 8; y++)
			outputFile.put(64 + x + frameNumber * 5);
}

void main2() {
	int width = 600;
	int height = 400;
	for (int num = 0; num < 50; num++) {
		/*
		len = len - 4;
		char b1 = len >> 24;
		char b2 = len << 8 >> 24;
		char b3 = len << 16 >> 24;
		char b4 = len << 24 >> 24;
		const char lenBytes[4]{ b1, b2, b3, b4 };
		outputFile.write(lenBytes, 4);
		outputFile.write((const char*)layerInfo.pBsBuf + 4, len);
		*/

		uint8_t sps[] = { 0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00,
			0x0a, 0xf8, 0x41, 0xa2 };
		uint8_t pps[] = { 0x00, 0x00, 0x00, 0x01, 0x68, 0xce,
			0x38, 0x80 };
		int8_t slice_header[] = { 0x00, 0x00, 0x00, 0x01, 0x05, 0x88,
			0x84, 0x21, 0xa0 };

		int len = 3 * (int)ceil(width / 16.0) * (int)ceil(height / 16.0) + sizeof(sps) + sizeof(pps) + sizeof(slice_header);

		auto fileName = std::string() + "frame" + std::to_string(num) + ".h264";
		std::ofstream outputFile(fileName, std::ios_base::binary);

		outputFile.write((const char*)sps, sizeof(sps));
		outputFile.write((const char*)pps, sizeof(pps));
		outputFile.write((const char*)slice_header, sizeof(slice_header));

		int i = 0;
		while (true) {
			int j = 0;
			while (true) {
				// Prints 3 * width * height bytes
				macroblock(i, j, num, outputFile);

				if (j >= width) break;
				j += 16;
			}

			if (i >= height) break;
			i += 16;
		}

		outputFile.put(0x80);
	}
}

//todonext
//ugh... read about h264 enough to understand how to get the output of here, and maybe enough to see what is wrong with the ffmpeg data.

void writeNALUnits(SFrameBSInfo& info, std::ofstream& outputFile) {

	printf("size: %d, frame type %d\n", info.iFrameSizeInBytes, info.eFrameType);
	printf("iLayerNum: %d, uiTimeStamp: %lld\n", info.iLayerNum, info.uiTimeStamp);
	for (int i = 0; i < info.iLayerNum; i++) {
		//for (int i = 0; i < 1; i++) {
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
		

		// Ignore the start code, and write a length prefixed start code.
		/*
		//if (i == 0) {
			if (layerInfo.pBsBuf[0] != 0) {
				throw "invalid start code";
			}
			if (layerInfo.pBsBuf[1] != 0) {
				throw "invalid start code";
			}
			if (layerInfo.pBsBuf[2] != 0) {
				throw "invalid start code";
			}
			if (layerInfo.pBsBuf[3] != 1) {
				throw "invalid start code";
			}
			len = len - 4;
			char b1 = len >> 24;
			char b2 = len << 8 >> 24;
			char b3 = len << 16 >> 24;
			char b4 = len << 24 >> 24;
			const char lenBytes[4]{ b1, b2, b3, b4 };
			outputFile.write(lenBytes, 4);
			outputFile.write((const char*)layerInfo.pBsBuf + 4, len);
		//}
		/*
		else {
			char b1 = len >> 24;
			char b2 = len << 8 >> 24;
			char b3 = len << 16 >> 24;
			char b4 = len << 24 >> 24;
			const char lenBytes[4]{ b1, b2, b3, b4 };
			outputFile.write(lenBytes, 4);
			outputFile.write((const char*)layerInfo.pBsBuf, len);
		}
		*/
		//*/

		//outputFile.write((const char*)layerInfo.pBsBuf, len);

		//outputFile.write(test, 600);
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
		//break;

		int breakhere = 5;
		//}
	}
}

void main() {
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

	int profile = PRO_CAVLC444;
	encoder->SetOption(ENCODER_OPTION_PROFILE, &profile);

	int level = LEVEL_2_2;
	encoder->SetOption(ENCODER_OPTION_LEVEL, &level);


	std::ifstream file("C:/Users/quent/Dropbox/camera/encoder/frame0.bmp");
	std::string content((std::istreambuf_iterator<char>(file)), (std::istreambuf_iterator<char>()));
	int length = content.length();
	unsigned char* data = (unsigned char*)content.c_str();

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
	for (int num = 0; num < 50; num++) {
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