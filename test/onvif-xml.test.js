'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const xml = require('../lib/adapter/onvif-xml');

const env = (body) =>
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tt="http://www.onvif.org/ver10/schema"' +
    ' xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl"' +
    ' xmlns:tr2="http://www.onvif.org/ver20/media/wsdl" xmlns:tds="http://www.onvif.org/ver10/device/wsdl">' +
    `<s:Body>${body}</s:Body></s:Envelope>`;

test('ptzStatus reads position and flat MoveStatus', async () => {
    const s = await xml.ptzStatus(
        env(
            '<tptz:GetStatusResponse><tptz:PTZStatus><tt:Position>' +
                '<tt:PanTilt x="0.25" y="-0.5" space="http://www.onvif.org/ver10/tptz/PanTiltSpaces/PositionGenericSpace"/>' +
                '<tt:Zoom x="0.1"/></tt:Position><tt:MoveStatus>IDLE</tt:MoveStatus>' +
                '<tt:UtcTime>2026-10-17T03:19:19Z</tt:UtcTime></tptz:PTZStatus></tptz:GetStatusResponse>'
        )
    );
    assert.deepEqual(s, {
        x: 0.25,
        y: -0.5,
        zoom: 0.1,
        moveStatus: 'IDLE',
        error: undefined,
        utcTime: '2026-10-17T03:19:19Z'
    });
});

test('ptzStatus reports missing Position as null, not 0', async () => {
    const s = await xml.ptzStatus(
        env(
            '<tptz:GetStatusResponse><tptz:PTZStatus><tt:MoveStatus><tt:PanTilt>MOVING</tt:PanTilt>' +
                '<tt:Zoom>IDLE</tt:Zoom></tt:MoveStatus></tptz:PTZStatus></tptz:GetStatusResponse>'
        )
    );
    assert.equal(s.x, null);
    assert.equal(s.y, null);
    assert.equal(s.zoom, null);
    assert.equal(s.moveStatus, 'panTilt=MOVING zoom=IDLE');
});

test('profiles: Media1 PTZConfiguration and Media2 Configurations/PTZ', async () => {
    const m1 = await xml.profiles(
        env(
            '<trt:GetProfilesResponse><trt:Profiles token="P0" fixed="true"><tt:Name>main</tt:Name>' +
                '<tt:VideoEncoderConfiguration token="V0"><tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>1920</tt:Width>' +
                '<tt:Height>1080</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration>' +
                '<tt:PTZConfiguration token="PTZ0"><tt:Name>ptz</tt:Name><tt:NodeToken>N0</tt:NodeToken></tt:PTZConfiguration>' +
                '</trt:Profiles><trt:Profiles token="P1"><tt:Name>sub</tt:Name></trt:Profiles></trt:GetProfilesResponse>'
        )
    );
    assert.equal(m1.length, 2);
    assert.deepEqual(m1[0], {
        token: 'P0',
        name: 'main',
        ptzConfigurationToken: 'PTZ0',
        ptzNodeToken: 'N0',
        encoding: 'H264',
        resolution: {width: 1920, height: 1080}
    });
    assert.equal(m1[1].ptzConfigurationToken, null);

    const m2 = await xml.profiles(
        env(
            '<tr2:GetProfilesResponse><tr2:Profiles token="P0"><tr2:Name>main</tr2:Name><tr2:Configurations>' +
                '<tr2:PTZ token="PTZ0"><tt:Name>ptz</tt:Name><tt:NodeToken>N0</tt:NodeToken></tr2:PTZ>' +
                '</tr2:Configurations></tr2:Profiles></tr2:GetProfilesResponse>'
        )
    );
    assert.equal(m2[0].ptzConfigurationToken, 'PTZ0');
});

test('ptzConfigurationOptions flattens spaces and skips Extension', async () => {
    const r = (a, b) => `<tt:Min>${a}</tt:Min><tt:Max>${b}</tt:Max>`;
    const o = await xml.ptzConfigurationOptions(
        env(
            '<tptz:GetConfigurationOptionsResponse><tptz:PTZConfigurationOptions><tt:Spaces>' +
                '<tt:AbsolutePanTiltPositionSpace><tt:URI>http://www.onvif.org/ver10/tptz/PanTiltSpaces/PositionGenericSpace</tt:URI>' +
                `<tt:XRange>${r(-1, 1)}</tt:XRange><tt:YRange>${r(-1, 1)}</tt:YRange></tt:AbsolutePanTiltPositionSpace>` +
                '<tt:AbsoluteZoomPositionSpace><tt:URI>http://www.onvif.org/ver10/tptz/ZoomSpaces/PositionGenericSpace</tt:URI>' +
                `<tt:XRange>${r(0, 1)}</tt:XRange></tt:AbsoluteZoomPositionSpace>` +
                '<tt:Extension><tt:Foo/></tt:Extension>' +
                `</tt:Spaces><tt:PTZTimeout>${r('PT1S', 'PT60S')}</tt:PTZTimeout></tptz:PTZConfigurationOptions>` +
                '</tptz:GetConfigurationOptionsResponse>'
        )
    );
    assert.deepEqual(
        o.spaces.map((s) => s.name),
        ['AbsolutePanTiltPositionSpace', 'AbsoluteZoomPositionSpace']
    );
    assert.deepEqual(o.spaces[0].x, {min: -1, max: 1});
    assert.deepEqual(o.spaces[1].x, {min: 0, max: 1});
    assert.equal(o.spaces[1].y, undefined);
    assert.deepEqual(o.ptzTimeout, {min: null, max: null});
});

test('mediaUri handles Media1 MediaUri/Uri and Media2 Uri', async () => {
    assert.equal(
        await xml.mediaUri(
            env(
                '<trt:GetSnapshotUriResponse><trt:MediaUri><tt:Uri>http://c/snap.jpg</tt:Uri></trt:MediaUri></trt:GetSnapshotUriResponse>'
            )
        ),
        'http://c/snap.jpg'
    );
    assert.equal(
        await xml.mediaUri(env('<tr2:GetStreamUriResponse><tr2:Uri>rtsp://c/1</tr2:Uri></tr2:GetStreamUriResponse>')),
        'rtsp://c/1'
    );
});

test('deviceInformation', async () => {
    const d = await xml.deviceInformation(
        env(
            '<tds:GetDeviceInformationResponse><tds:Manufacturer>VIP</tds:Manufacturer><tds:Model>G28</tds:Model>' +
                '<tds:FirmwareVersion>V3.1</tds:FirmwareVersion><tds:SerialNumber>S1</tds:SerialNumber>' +
                '<tds:HardwareId>H1</tds:HardwareId></tds:GetDeviceInformationResponse>'
        )
    );
    assert.deepEqual(d, {
        manufacturer: 'VIP',
        model: 'G28',
        firmwareVersion: 'V3.1',
        serialNumber: 'S1',
        hardwareId: 'H1'
    });
});
