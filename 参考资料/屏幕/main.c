#include "stm32f10x.h"                  // Device header
#include "Lcd_Driver.h"
#include "GUI.h"
#include "Picture.h"



int main(void)
{
	Lcd_Init();
	LCD_LED_SET;
	Lcd_Clear(WHITE);
	
	Gui_showimage(gImage_1, 60, 60, 1, 1);
	Gui_DrawFont_GBK16(1, 100, BLACK, WHITE, "ÄãºÃ,ÊÀ½ç");
	
	while (1)
	{
					
	}
}
