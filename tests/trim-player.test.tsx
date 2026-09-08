import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { TrimPlayer } from "../src/features/input/TrimPlayer";
const { state } = vi.hoisted(() => ({state: {} as any}));
vi.mock("@/state/shift", () => ({useShift:()=>state}));
vi.mock("@tauri-apps/api/core", () => ({convertFileSrc:(path:string)=>path}));
let pause: ReturnType<typeof vi.fn>;
let play: ReturnType<typeof vi.fn>;
beforeEach(()=>{
 Object.assign(state,{duration:8,clipIn:"00:02.000",clipOut:"00:04.000",clipError:null,clipLabel:"00:02.000",showAspect:false,aspectPreview:null,setClipIn:vi.fn(),setClipOut:vi.fn(),playback:{info:{path:"/tone.mp3",duration:8,hasVideo:false,proxy:false},busy:false,error:null,status:"ready",cancel:vi.fn(),retry:vi.fn(),fallback:vi.fn(),markReady:vi.fn()}});
 pause=vi.fn(function(this:HTMLMediaElement){Object.defineProperty(this,"paused",{value:true,configurable:true});this.dispatchEvent(new Event("pause"));});
 play=vi.fn(function(this:HTMLMediaElement){Object.defineProperty(this,"paused",{value:false,configurable:true});this.dispatchEvent(new Event("play"));return Promise.resolve();});
 vi.spyOn(HTMLMediaElement.prototype,"pause").mockImplementation(pause);
 vi.spyOn(HTMLMediaElement.prototype,"play").mockImplementation(play);
});
afterEach(cleanup);
function setup(){ const view=render(<TrimPlayer/>);const video=view.container.querySelector("video")!;fireEvent.loadedMetadata(video);return {...view,video}; }
test("play starts at beginning, seek leaves bounds alone, Set IN/OUT use the playhead",async()=>{
 const {video}=setup();fireEvent.click(screen.getByRole("button",{name:"Play",exact:true}));await act(async()=>{});expect(video.currentTime).toBe(0);expect(play).toHaveBeenCalled();
 fireEvent.change(screen.getByLabelText("Seek playback"),{target:{value:3}});expect(video.currentTime).toBe(3);expect(state.setClipIn).not.toHaveBeenCalled();expect(state.setClipOut).not.toHaveBeenCalled();
 fireEvent.click(screen.getByText("Set IN"));expect(state.setClipIn).toHaveBeenCalledWith("00:03.000");fireEvent.click(screen.getByText("Set OUT"));expect(state.setClipOut).toHaveBeenCalledWith("00:03.000");
});
test("drag handles cannot cross, typed edits share the same setters",()=>{
 setup();fireEvent.change(screen.getByLabelText("IN marker"),{target:{value:7}});expect(state.setClipIn).toHaveBeenCalledWith("00:03.999");
 fireEvent.change(screen.getByLabelText("OUT marker"),{target:{value:1}});expect(state.setClipOut).toHaveBeenCalledWith("00:02.001");
 fireEvent.change(screen.getByLabelText("IN",{selector:"input"}),{target:{value:"00:01.250"}});expect(state.setClipIn).toHaveBeenCalledWith("00:01.250");
});
test("Play Selection seeks to IN and stops at OUT",async()=>{
 const {video}=setup();video.currentTime=6;fireEvent.click(screen.getByText("Play Selection"));await act(async()=>{});expect(video.currentTime).toBe(2);
 video.currentTime=4.02;fireEvent.timeUpdate(video);expect(pause).toHaveBeenCalled();expect(video.currentTime).toBe(4);
});
test("invalid range cannot play selection; preview errors leave controls visible",()=>{
 state.clipError="OUT has to come after IN.";setup();expect((screen.getByText("Play Selection") as HTMLButtonElement).disabled).toBe(true);expect(screen.getByRole("status").textContent).toContain("OUT has to");
});
test("new source clears player position and failure requests proxy fallback",()=>{
 const {video,rerender}=setup();video.currentTime=3;fireEvent.timeUpdate(video);fireEvent.error(video);expect(state.playback.fallback).toHaveBeenCalled();
 state.playback.info={...state.playback.info,path:"/other.mp3"};rerender(<TrimPlayer/>);expect(screen.getByText(/00:00.000 \/ 00:08.000/)).toBeTruthy();
});
test("space pauses only outside editing controls",async()=>{
 const {video}=setup();fireEvent.keyDown(screen.getByLabelText("Trim player"),{code:"Space"});await act(async()=>{});expect(play).toHaveBeenCalledTimes(1);
 fireEvent.keyDown(screen.getByLabelText("IN",{selector:"input"}),{code:"Space"});expect(pause).not.toHaveBeenCalled();fireEvent.keyDown(screen.getByLabelText("Trim player"),{code:"Space"});expect(pause).toHaveBeenCalled();expect(video.paused).toBe(true);
});
